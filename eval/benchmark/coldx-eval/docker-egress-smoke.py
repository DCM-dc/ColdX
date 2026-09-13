#!/usr/bin/env python3
"""Actual pinned Pier/Squid Docker acceptance, using only a host loopback fake provider."""
import argparse
import asyncio
import hashlib
import json
import logging
import os
from pathlib import Path
import secrets
import shlex
import shutil
import sys
import time


async def command(*args):
    process = await asyncio.create_subprocess_exec(*args, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    stdout, stderr = await process.communicate()
    if process.returncode:
        raise RuntimeError(f"Command failed with code {process.returncode}: {args[0]}")
    return stdout.decode()


async def main(args):
    # The operator supplies the prepared, pinned Linux Pier source; no package/source mutation here.
    sys.path.insert(0, str(Path(args.pier_source).resolve() / 'src'))
    from pier.environments.docker.docker import DockerEnvironment
    from pier.models.agent.network import NetworkAllowlist
    from pier.models.task.config import EnvironmentConfig
    from pier.models.trial.paths import TrialPaths

    source = Path(__file__).resolve().parent
    output = Path(args.output).resolve()
    output.mkdir(mode=0o700)
    report = {'schema': 'coldx-pier-docker-egress-acceptance-v1', 'mockOnly': True,
              'measuredBenchmarkReward': None, 'status': 'running', 'checks': {}, 'startedAt': time.time()}
    stage = 'docker-preflight'
    environment = None
    host_relay = None
    sentinel = secrets.token_hex(32)
    relay_config = {}
    logger = logging.getLogger('coldx-egress-smoke')
    logger.addHandler(logging.NullHandler())
    logger.propagate = False
    try:
        info = json.loads(await command('docker', 'info', '--format', '{{json .}}'))
        assert info['OSType'] == 'linux'
        bridge_info = json.loads(await command('docker', 'network', 'inspect', 'bridge'))[0]
        bridge_ip = next(item['Gateway'] for item in bridge_info['IPAM']['Config'] if '.' in item.get('Gateway', ''))
        report['docker'] = {'serverVersion': info['ServerVersion'], 'osType': info['OSType'], 'bridgeIp': bridge_ip}
        inputs = output / 'readonly-probe'
        inputs.mkdir()
        for name in ['evaluation-proxy.mjs', 'evaluation-dispatcher.mjs', 'docker-egress-smoke-client.mjs']:
            shutil.copyfile(source / name, inputs / name)
        (inputs / 'readonly-marker.txt').write_text('original-readonly-marker\n')
        environment_dir = output / 'environment'
        environment_dir.mkdir()
        (environment_dir / 'Dockerfile').write_text('FROM ubuntu:24.04\n')
        trial_paths = TrialPaths(output / 'trial')
        trial_paths.mkdir()
        private = output / 'host-private-relay'
        node = Path(args.node).resolve()
        stage = 'host-mock-relay'
        child_env = {key: os.environ[key] for key in ['PATH', 'LANG', 'LC_ALL', 'HOME', 'TMPDIR'] if key in os.environ}
        child_env['COLDX_SMOKE_PROVIDER_SENTINEL'] = sentinel
        undici_module = Path(args.undici_module).resolve()
        host_relay = await asyncio.create_subprocess_exec(str(node), str(source / 'docker-egress-smoke-relay.mjs'), bridge_ip, str(private), str(undici_module),
            env=child_env, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        ready = json.loads(await asyncio.wait_for(host_relay.stdout.readline(), 15))
        assert ready['event'] == 'mock-relay-ready'
        assert ready['sentinelSha256'] == hashlib.sha256(sentinel.encode()).hexdigest()
        relay_config = json.loads((private / 'downstream.private.json').read_text())
        stage = 'pier-environment-start'
        session_id = 'coldx-egress-smoke-' + secrets.token_hex(5)
        environment = DockerEnvironment(environment_dir=environment_dir, environment_name='coldx-egress-smoke',
            session_id=session_id, trial_paths=trial_paths, logger=logger,
            task_env_config=EnvironmentConfig(docker_image='ubuntu:24.04', cpus=2, memory_mb=8192,
                storage_mb=20480, allow_internet=False, workdir='/'),
            network_allowlist=NetworkAllowlist(domains=[bridge_ip]),
            mounts_json=[{'type': 'bind', 'source': str(inputs), 'target': '/opt/probe', 'read_only': True},
                         {'type': 'bind', 'source': str(node.parent.parent), 'target': '/opt/node', 'read_only': True},
                         {'type': 'bind', 'source': str(undici_module.parent), 'target': '/opt/undici', 'read_only': True}])
        await environment.start(force_build=False)
        stage = 'container-inspection'
        main_id = (await command('docker', 'ps', '-q', '--filter', f'label=com.docker.compose.project={session_id}',
                                 '--filter', 'label=com.docker.compose.service=main')).strip()
        assert main_id
        inspection = json.loads(await command('docker', 'inspect', main_id))[0]
        host_config = inspection['HostConfig']
        networks = list(inspection['NetworkSettings']['Networks'])
        assert len(networks) == 1
        internal = json.loads(await command('docker', 'network', 'inspect', networks[0]))[0]['Internal']
        mounts = {item['Destination']: item for item in inspection['Mounts']}
        checks = report['checks']
        checks['taskOnSingleInternalNetwork'] = internal is True
        checks['noPrivilegedOrHostPid'] = not host_config['Privileged'] and host_config['PidMode'] != 'host'
        checks['twoCpuLimit'] = host_config['NanoCpus'] == 2_000_000_000 or (
            host_config.get('CpuQuota', 0) > 0 and host_config['CpuQuota'] / host_config['CpuPeriod'] == 2)
        checks['eightGiBMemoryLimit'] = host_config['Memory'] == 8192 * 1024 * 1024
        checks['readonlyCodeAndNodeMounts'] = all(path in mounts and not mounts[path]['RW'] for path in ['/opt/probe', '/opt/node'])
        checks['defaultLogMountsRetained'] = all(path in mounts for path in ['/logs/agent', '/logs/verifier', '/logs/artifacts'])
        checks['privateDirectoryNotMounted'] = all(str(private) not in item['Source'] and item['Destination'] != '/var/run/docker.sock'
                                                  for item in inspection['Mounts'])
        checks['providerSentinelAbsentFromContainerConfig'] = sentinel not in json.dumps(inspection['Config'])
        assert all(checks.values())
        stage = 'container-probe'
        probe_env = {**relay_config, 'COLDX_SMOKE_SENTINEL_SHA256': ready['sentinelSha256'],
            'COLDX_SMOKE_HOST_PID_NAMESPACE': os.readlink('/proc/self/ns/pid'), 'COLDX_SMOKE_HOST_PRIVATE_PATH': str(private)}
        probe_env = environment.agent_process_env(probe_env)
        result = await environment.exec('/opt/node/bin/node --use-env-proxy /opt/probe/docker-egress-smoke-client.mjs',
                                        env=probe_env, timeout_sec=40)
        # Only the probe's bounded, intentionally sanitized JSON is copied into the public report.
        stdout = result.stdout or ''
        assert sentinel not in stdout and relay_config['COLDX_EVAL_UPSTREAM_API_KEY'] not in stdout
        probe = json.loads(stdout.strip().splitlines()[-1])
        report['probe'] = probe
        assert result.return_code == 0 and probe['status'] == 'passed'
        checks['sourceMarkerUnchanged'] = (inputs / 'readonly-marker.txt').read_text() == 'original-readonly-marker\n'
        checks['defaultAgentLogWritten'] = (trial_paths.agent_dir / 'smoke-log-write.txt').exists()
        stage = 'host-relay-final-accounting'
        host_relay.terminate()
        await asyncio.wait_for(host_relay.wait(), 15)
        provider = json.loads((private / 'mock-provider-report.json').read_text())
        external = json.loads((private / 'transport-report.json').read_text())
        report['mockProvider'] = provider
        report['externalTransport'] = external['stats']
        checks['onlyExpectedProviderRequests'] = provider['requests'] == 3 and provider['authenticatedRequests'] == 3
        checks['finalWireVerified'] = provider['finalWireVerified'] is True
        checks['cancellationReachedHostProvider'] = provider['cancelledStreams'] == 1 and external['stats']['clientCancelledRequests'] == 1 \
            and external['stats']['shutdownCancelledRequests'] == 0
        checks['usageIsNotDoubleCounted'] = external['stats']['tokenAccounting']['totals']['totalTokens'] == 35
        checks['filesCountedSeparately'] = external['stats']['forwardedRequests'] == 2 and external['stats']['files']['successfulUploads'] == 1
        assert all(checks.values())
        report['status'] = 'passed'
        report['note'] = 'Actual pinned Pier DockerEnvironment + generated Squid, isolated mock transport only. This is not a benchmark reward or model quality run.'
    except Exception as error:
        report['status'] = 'failed'
        report['failure'] = {'stage': stage, 'type': type(error).__name__}
        message = str(error).replace(sentinel, '<mock-provider-credential-redacted>')
        for value in relay_config.values():
            if value:
                message = message.replace(value, '<relay-config-redacted>')
        if environment is not None:
            for value in (environment.agent_process_env({}) or {}).values():
                if value:
                    message = message.replace(value, '<egress-config-redacted>')
        (output / 'diagnostic.redacted.txt').write_text(message[:16384] + '\n')
        # Never persist arbitrary provider/command errors or environment values in the shareable report.
    finally:
        if environment is not None:
            await environment.stop(delete=False)
        if host_relay is not None and host_relay.returncode is None:
            host_relay.terminate()
            try:
                await asyncio.wait_for(host_relay.wait(), 15)
            except asyncio.TimeoutError:
                host_relay.kill()
                await host_relay.wait()
        report['finishedAt'] = time.time()
        rendered = json.dumps(report, indent=2) + '\n'
        assert sentinel not in rendered
        if relay_config:
            assert relay_config['COLDX_EVAL_UPSTREAM_API_KEY'] not in rendered
        (output / 'docker-egress-report.json').write_text(rendered)
        print(json.dumps({'status': report['status'], 'report': str(output / 'docker-egress-report.json'),
                          'failure': report.get('failure')}))
    return report['status'] == 'passed'


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--pier-source', required=True)
    parser.add_argument('--node', default='/opt/coldx-benchmark/linux-dist/node/bin/node')
    parser.add_argument('--undici-module', default='/opt/coldx-benchmark/linux-dist/app/node_modules/.pnpm/undici@7.29.1/node_modules/undici/index.js')
    parser.add_argument('--output', required=True)
    parsed = parser.parse_args()
    sys.exit(0 if asyncio.run(main(parsed)) else 1)
