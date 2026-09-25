// No bundled React: DSH supplies its existing browser instance to this factory.
export function createWorkbenchPlugin(React, { MarkdownText }, factories, css) {
  const h = React.createElement;
  const { Mark, Name, faviconHref } = factories.brand(React);
  const { Home, KernelStatus } = factories.workspaceShell(React);
  const { Sidebar, Summary, icon } = factories.workbenchShell(React);
  function PageQuestion() { return h('span', { className: 'coldx-page-question', hidden: true, 'aria-hidden': true }); }
  return {
    inject: ['layout', 'slots', 'theme', 'connection', 'sessions', 'settingsScope', 'workspaces', 'remote', 'remote.commands', 'remote.fileReferences'],
    apply(ctx) {
      const frost = factories.frost(React, factories.motion);
      const rpcFor = service => async (method, request, signal) => {
        const response = await ctx.connection.rpc.call('/api',`${service}/${method}`,{args:{request}},signal);
        if (!response?.ok) throw new Error(response?.error?.message || '服务暂时不可用，请稍后重试。');
        return response.value;
      };
      const superpowers = factories.superpowers(React,rpcFor('coldxSuperpowers'));
      const {SuperpowersControl,SuperpowersSettingsRow} = superpowers;
      ctx.effect(()=>()=>superpowers.dispose());
      const {UsageEntry,UsageSettingsRow,BalanceNotice,UsageDialog} = factories.usage(React,rpcFor('coldxUsage'));
      const {UpdateNotice,UpdateSettingsRow} = factories.updates(React,rpcFor('coldxUpdates'));
      const { ModelControl } = factories.modelControl(React);
      function EnhancedModelControl(props) { return h(ModelControl,{...props,superpowersControl:h(SuperpowersControl)}); }
      const { MarketplaceEntry, MarketplaceDialog } = factories.marketplace(React, {}, async (method, request, signal) => {
        const response = await ctx.connection.rpc.call('/api', `coldxMarketplace/${method}`, {args:{request}}, signal);
        if (!response?.ok) throw new Error(response?.error?.message || '插件市场暂时不可用。');
        return response.value;
      }, {openSession:id=>ctx.sessions.open(id),getSessionId:()=>{
        const id=ctx.sessions.list.getSnapshot().current;
        return id&&!ctx.sessions.subagentAddress?.(id)?id:undefined;
      }});
      const menuCatalog = factories.menuCatalog({ connection: ctx.connection, sessions: ctx.sessions });
      ctx.effect(() => () => menuCatalog.dispose());
      ctx.effect(() => ctx.remote.$on?.('agent-preset/selected', sessionId => menuCatalog.invalidate(sessionId)));
      ctx.effect(() => ctx.on?.('connection/reset', () => menuCatalog.invalidate()));
      const { CodingModeControl, CodingModeChips, ModeCommandReceipt, focusComposerSurface, createModeCoordinator } = factories.sessionControls(React, frost);
      const pane = factories.workbenchPane(React);
      const readTheme = () => ctx.theme.getTheme().active.colorScheme;
      const subscribeTheme = listener => ctx.on('theme/change', listener);
      const { HtmlPreview } = factories.htmlPreview(React, factories.document, readTheme, subscribeTheme);
      const { PdfPreview } = factories.pdf(React);
      const files = factories.files(React, MarkdownText, async (sessionId, method, path, signal) => {
        const address = ctx.sessions.subagentAddress?.(sessionId);
        const operation = address ? (method === 'listFiles' ? 'listChildFiles' : 'readChildFile') : method;
        const args = { ...(address ? {address} : {agentId:sessionId}), request:{path} };
        const response = await ctx.connection.rpc.call('/api', `coldxFiles/${operation}`, {args}, signal);
        if (!response?.ok) throw new Error(response?.error?.message || '文件读取失败。');
        return response.value;
      }, ctx.connection.isLoopback ? path => ctx.workspaces.openPath(path) : undefined, {HtmlPreview,PdfPreview,pane,getReferenceTarget(sessionId) {
        let current = sessionId;
        const visited = new Set();
        while (!visited.has(current)) {
          visited.add(current);
          const address = ctx.sessions.subagentAddress?.(current);
          if (!address) break;
          current = address.parentSessionId;
        }
        return current !== sessionId && !ctx.sessions.subagentAddress?.(current) ? {sessionId:current,open:()=>ctx.sessions.open(current)} : undefined;
      }});
      ctx.provide('coldxFilePreview', { open: files.open, resolve: files.resolve });
      const navigation=factories.navigation(React,ctx,{icon,api:rpcFor('coldxWorkbench'),Marketplace:MarketplaceDialog,Usage:UsageDialog,files,pane});
      ctx.provide('coldxNavigation',navigation);
      for(const [id,component,order] of [['coldx-balance',BalanceNotice,40],['coldx-update',UpdateNotice,50]])ctx.slots.inject('sidebar.footer.action',()=>ctx.slots.register({name:'sidebar.footer.action',id,order},component));
      ctx.slots.inject('sidebar.workspaces',()=>ctx.slots.register({name:'sidebar.workspaces',priority:-10},navigation.TaskList));
      ctx.slots.inject('shell.overlay',()=>ctx.slots.register({name:'shell.overlay',id:'coldx-pages',order:20},navigation.Pages));
      ctx.slots.inject('conversation.chat.node',()=>{
        const native=ctx.slots.entries('conversation.chat.node').find(entry=>entry.options.key==='assistant-step');
        if(!native)return()=>{};
        const {AssistantMessage}=factories.messages(React,files,native.component);
        return ctx.slots.register({name:'conversation.chat.node',key:'assistant-step',priority:-10,locale:'conversation'},AssistantMessage);
      });
      const { AttachmentControl, ComposerAttachments } = factories.attachments(React, frost);
      const activity = factories.activity(React, frost, factories.motion);
      const { useComputer, ComputerPreview, ComputerStatus, ComputerWorkspace } = factories.computer(React, async (sessionId, method, request, signal) => {
        const address = ctx.sessions.subagentAddress?.(sessionId);
        const response = await ctx.connection.rpc.call('/api', `coldxComputer/${method}${address ? 'Child' : ''}`, { args: { ...(address ? {address} : {agentId:sessionId}), request } }, signal);
        if (!response?.ok) throw new Error(response?.error?.message || '浏览器操作暂时不可用。');
        return response.value;
      });
      const terminalSettings = ctx.settingsScope.bind({
        namespace: 'coldx-activity',
        decode(section) {
          if (!section || typeof section !== 'object' || typeof section.showTerminal !== 'boolean') return undefined;
          return { showTerminal: section.showTerminal };
        },
      });
      const { SessionTerminal, TerminalSettingsRow } = factories.terminal(React, activity, terminalSettings, frost, async (sessionId, request, signal) => {
        const address = ctx.sessions.subagentAddress?.(sessionId);
        const response = await ctx.connection.rpc.call('/api', address ? 'coldxTerminal/readChild' : 'coldxTerminal/read', { args: { ...(address ? {address} : {agentId:sessionId}), request } }, signal);
        if (!response?.ok) throw new Error(response?.error?.message || '终端流暂时不可用。');
        return response.value;
      });
      ctx.effect(() => () => frost.dispose());
      const { QuestionFrame } = factories.interactions(React, factories.document, factories.interactionSubmit, readTheme, factories.motion, subscribeTheme);
      const { InlineTool } = factories.stage(React, factories.document, factories.pageSubmit, readTheme, MarkdownText, QuestionFrame, factories.workspaceModel, factories.motion, subscribeTheme);
      const model = factories.workspaceModel();
      function hasInlineCall(carrier, session) {
        if (!model.canPresent(carrier) || carrier.payload.questions.length !== 1) return false;
        const match = /^coldx-(page|interaction):(.+):1$/.exec(carrier.payload.questions[0].id);
        if (!match || !session?.chat?.nodes) return false;
        const toolName = match[1] === 'page' ? 'coldx_present_page' : 'coldx_interact';
        const calls = [];
        for (const key of session.chat.order ?? []) {
          const node = session.chat.nodes.get(key);
          if (node?.kind === 'tool-call' && node.data?.root) calls.push(node.data.root);
        }
        while (calls.length) {
          const block = calls.pop();
          const name = 'kind' in block ? block.call?.name : block.name;
          if (block.callId === match[2] && name === toolName) return true;
          calls.push(...(block.subCalls ?? []));
        }
        return false;
      }
      function HomeBrand() {
        return h(Home);
      }
      function KernelDetails({sessionId}) {
        const [open,setOpen] = React.useState(false);
        const [state,setState] = React.useState({snapshot:null,loading:false,error:null});
        React.useEffect(() => {
          if (!open || !sessionId) return;
          const controller = new AbortController();
          let timer;
          async function read() {
            setState(value=>({...value,loading:true}));
            try {
              const address = ctx.sessions.subagentAddress?.(sessionId);
              const response = await ctx.connection.rpc.call('/api', address ? 'coldxKernel/readChild' : 'coldxKernel/read', {
                args: {...(address ? {address} : {agentId:sessionId}),request:{}},
              },controller.signal);
              if (!response?.ok) throw new Error(response?.error?.message || '运行状态暂时不可用。');
              if (!controller.signal.aborted) setState({snapshot:response.value,loading:false,error:null});
            } catch(error) {
              if (!controller.signal.aborted) setState(value=>({...value,loading:false,error}));
            } finally {
              if (!controller.signal.aborted) timer=setTimeout(read,2000);
            }
          }
          void read();
          return ()=>{controller.abort();clearTimeout(timer);};
        },[sessionId,open]);
        return h(KernelStatus,{...state,onOpenChange:setOpen});
      }
      async function runCommand(sessionId, command) {
          if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('请先打开一个会话。');
          const receipt = await ctx.remote.commands.execute(sessionId, command, []);
          const result = receipt?.value?.result;
          if (!receipt || receipt.ok !== true || result?.kind !== 'success') {
            const reason = result?.text ?? result?.message ?? result?.error ?? receipt?.error;
            throw new Error(typeof reason === 'string' ? reason : reason?.message || '命令未被接收，请重试。');
          }
          // Admission is not a mode transition. Native projections own state.
      }
      const modes = createModeCoordinator({ executeCommand: runCommand, readSession: id => typeof id === 'string' ? ctx.sessions.binding(id)?.session.getSnapshot() : undefined });
      ctx.provide('coldxCodingMode', modes);
      ctx.effect(() => () => modes.dispose());
      function ModeChips(props) { return h(CodingModeChips, modes.useControls(props)); }
      function InputTools(props) { return h(files.InputReferenceBridge, props); }
      function InputAdd(props) {
        const modeProps = modes.useControls(props);
        async function listFiles(query, signal) {
          const sessionId = props.sessionId;
          if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('请先打开一个会话。');
          const receipt = await ctx.remote.fileReferences.list(sessionId, query, signal);
          if (!receipt || receipt.ok !== true || !Array.isArray(receipt.value)) {
            const reason = receipt?.error;
            throw new Error(typeof reason === 'string' ? reason : reason?.message || '文件列表加载失败。');
          }
          return receipt.value;
        }
        async function uploadFile(file, signal) {
          const sessionId = props.sessionId;
          if (typeof sessionId !== 'string' || !sessionId.trim()) throw new Error('请先打开一个会话。');
          if (!Number.isSafeInteger(file?.size) || file.size < 0 || file.size > 8 * 1024 * 1024) throw new Error('单个文件不能超过 8 MB。');
          signal?.throwIfAborted();
          const bytes = new Uint8Array(await file.arrayBuffer());
          if (bytes.length !== file.size) throw new Error('文件大小发生变化，请重新选择。');
          let binary = '';
          for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
          signal?.throwIfAborted();
          const response = await ctx.connection.rpc.call('/api', 'coldxFiles/importFile', {
            args: { agentId: sessionId, request: { name: file.name, mime: file.type || 'application/octet-stream', size: bytes.length, base64: btoa(binary) } },
          }, signal);
          if (!response?.ok || typeof response.value?.path !== 'string') throw new Error(response?.error?.message || '文件上传失败，请重试。');
          return response.value;
        }
        return h(React.Fragment, null,
          h(AttachmentControl, {
            unified: true,
            modeItems: h(CodingModeControl, { ...modeProps, embedded: true }),
            locked: props.locked,
            commandsAvailable: props.commandsAvailable,
            openCommands: props.openCommands,
            getInputSelection: props.getInputSelection,
            loadPlugins: menuCatalog.load,
            onPickPlugin: (name, selection) => menuCatalog.pick(props.sessionId, name, {input:props.input, selection, locked:props.locked}),
            sessionId: props.sessionId,
            draft: props.input?.draft ?? '',
            setDraft: value => props.inputActions?.setDraft?.(value),
            listFiles,
            uploadFile,
          }));
      }
      function SessionUtilities(props) {
        const session = props.useSession(value => value);
        const sessionId = props.sessionId ?? session?.sessionId;
        const computerState = useComputer(sessionId);
        const pages = props.useProjection('coldx.pages');
        const flow = props.useProjection('coldx.flow');
        const subagents = props.useSessions(state => state?.subagentsByParent?.[sessionId]);
        const jobs = props.useSessions(state => state?.jobsBySession?.[sessionId] ?? []);
        const sessionsState = props.useSessions(state => state);
        const trajectory = session?.views?.get?.('trajectory');
        files.setKnown(sessionId, (activity.selectActivityOutputs?.({sessionId,session,pages,sessionsState}) ?? []).filter(item => item.kind === 'file' && item.operation !== 'delete').map(item => item.path));
        React.useEffect(() => {
          // Explicit local Markdown links use the same in-app reader as native file chips.
          const click = event => {
            if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
            const anchor = event.target.closest?.('a[href]');
            if (!anchor?.closest('.wSkVaW_root') || anchor.closest('.cx-file-workspace')) return;
            const href = anchor.getAttribute('href');
            const local = files.parseLocalFileLink(href);
            if (!local || !/\.[a-z0-9]{1,10}$/iu.test(local.path)) return;
            event.preventDefault(); event.stopPropagation();
            files.open(sessionId, local.path, local.line);
          };
          document.addEventListener('click', click, true);
          return () => document.removeEventListener('click', click, true);
        }, [sessionId]);
        const summaryModel = activity.selectActivityModel({sessionId,session,trajectory,pages,flow,subagents,jobs,sessionsState,computer:computerState.snapshot});
        return h(React.Fragment, null, h(Summary, {key:sessionId,sessionId,model:summaryModel,
          onOpenView:view=>pane.open(sessionId,view),
          onOpenFile:(path,line)=>files.open(sessionId,path,line),
          onOpenSubagent:address=>ctx.sessions.openSubagent(address),
          onOpenOutput:output=>{
            if(output.kind==='file')return files.open(sessionId,output.path);
            const page=[...document.querySelectorAll('[data-coldx-call-id]')].find(node=>node.getAttribute('data-coldx-call-id')===output.pageId);
            page?.scrollIntoView({block:'center'});
          },
        }), h(files.FileWorkspace, { sessionId }), h(ComputerWorkspace,{sessionId,state:computerState,pane}), h(activity.ActivityLens, {
          sessionId, session, trajectory, pages, flow, subagents, jobs, sessionsState, pane,
          computer: computerState.snapshot,
          computerControls: h(ComputerStatus, { state: computerState }),
          renderComputerPreview: record => h(ComputerPreview, { record, latest: record.callId === computerState.snapshot.records.findLast(item => item.previewAttachment)?.callId }),
          onOpenSubagent: address => ctx.sessions.openSubagent(address),
          onOpenFile: (path, line) => files.open(sessionId, path, line),
          onOpenOutput: output => {
            if (output.kind === 'file') return files.open(sessionId, output.path);
            const page = [...document.querySelectorAll('[data-coldx-call-id]')].find(node => node.getAttribute('data-coldx-call-id') === output.pageId);
            if (page) { page.scrollIntoView({block:'center',behavior:'auto'}); page.querySelector('button,iframe')?.focus?.({preventScroll:true}); }
          },
        }));
      }
      function TerminalDock({ sessionId, session }) {
        // InputZone supplies a coherent owner snapshot and measures dock height.
        return h(SessionTerminal, { sessionId, session });
      }
      for (const [name, component] of [
        ['sidebar.brand.mark', Mark], ['sidebar.brand.name', Name],
        ['conversation.hero.brand.mark', HomeBrand], ['conversation.input.left', InputTools],
      ]) ctx.slots.inject(name, () => ctx.slots.register({ name, id: 'coldx', order: 80, priority: 10 }, component));
      ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
        name:'sidebar.footer.action', id:'coldx-marketplace', order:-10,
      }, navigation.Nav));
      ctx.slots.inject('conversation.input.attachments', () => ctx.slots.register({
        // Native single slots choose the lowest priority; the built-in entry is 0.
        name: 'conversation.input.attachments', priority: -10,
      }, ComposerAttachments));
      ctx.slots.inject('conversation.input.plan', () => ctx.slots.register({ name: 'conversation.input.plan', priority: -10 }, ModeChips));
      ctx.slots.inject('conversation.input.add', () => ctx.slots.register({ name: 'conversation.input.add', priority: -10 }, InputAdd));
      ctx.slots.inject('conversation.input.model.effort', () => ctx.slots.register({ name: 'conversation.input.model.effort', priority: -10 }, EnhancedModelControl));
      for (const key of ['plan', 'coldx-goal']) ctx.slots.inject('conversation.chat.commandview', () => ctx.slots.register({ name: 'conversation.chat.commandview', key, priority: -10 }, ModeCommandReceipt));
      ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'coldx-activity', order: 80,
      }, SessionUtilities));
      ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
        name: 'conversation.input.dock', id: 'coldx-terminal', order: -10,
      }, TerminalDock));
      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item', id: 'coldx-terminal', order: 70,
      }, TerminalSettingsRow));
      for (const [id,component,order] of [['coldx-superpowers',SuperpowersSettingsRow,71],['coldx-usage',UsageSettingsRow,72],['coldx-update',UpdateSettingsRow,73]]) ctx.slots.inject('settings.general.item',()=>ctx.slots.register({name:'settings.general.item',id,order},component));
      for (const key of ['coldx_present_page', 'coldx_interact']) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
        name: 'tool.call.toolview', key, id: 'coldx', priority: 10,
      }, InlineTool));
      ctx.slots.inject('conversation.composer', () => ctx.slots.register({
        name: 'conversation.composer', id: 'coldx-page-wait', priority: -10,
        select: ({ interactions, session }) => {
          // Keep the native composer until each ColdX question has its own
          // visible tool node. Ordinary questions and approvals stay native.
          if (!interactions.length || !interactions.every(carrier => hasInlineCall(carrier, session))) return null;
          return interactions.at(-1);
        },
      }, PageQuestion));
      ctx.effect(() => ctx.theme.overrideTokens('coldx', {
        '--dsw-alias-bg-base': { light: '#ffffff', dark: '#181818' },
        '--dsw-specific-sidebar-fill': { light: '#f9f9f9', dark: '#000000' },
        '--dsw-specific-input-major': { light: '#ffffff', dark: '#212121' },
        '--dsw-specific-menu': { light: '#f9f9f9', dark: '#212121' },
        '--dsw-specific-bubble': { light: '#f3f3f3', dark: '#414141' },
        '--dsw-alias-label-primary': { light: '#1a1c1f', dark: '#dfdfdf' },
        '--dsw-alias-label-secondary': { light: '#1a1c1fb3', dark: '#ffffffb3' },
        '--dsw-alias-label-tertiary': { light: '#1a1c1f80', dark: '#ffffff80' },
        '--dsw-alias-state-business-primary': { light: '#1a1c1f', dark: '#dfdfdf' },
        '--dsw-alias-button-info-fill': { light: '#1a1c1f', dark: '#dfdfdf' },
      }));
      if (typeof document !== 'undefined') ctx.effect(() => {
        const previous = document.title;
        const alreadyStyled = document.documentElement.classList.contains('coldx-shell');
        const style = document.createElement('style');
        style.dataset.coldx = 'presentation'; style.textContent = css;
        document.head.appendChild(style); document.documentElement.classList.add('coldx-shell');
        const icons = [...document.querySelectorAll('link[rel~="icon"]')];
        const createdIcon = icons.length === 0 && faviconHref ? document.createElement('link') : null;
        if (createdIcon) { createdIcon.rel = 'icon'; document.head.appendChild(createdIcon); icons.push(createdIcon); }
        const previousIcons = icons.map(icon => ({ icon, href: icon.getAttribute('href'), type: icon.getAttribute('type'), sizes: icon.getAttribute('sizes') }));
        if (faviconHref) for (const icon of icons) {
          icon.setAttribute('href', faviconHref); icon.setAttribute('type', 'image/svg+xml'); icon.removeAttribute('sizes');
        }
        // rc.2's renderer owns session-title updates but has a build-time product suffix.
        const brandTitle = () => {
          const title = document.title;
          if (title === 'DeepSeek Harness') document.title = 'ColdX · AI 工作台';
          else if (title.endsWith(' — DeepSeek Harness')) document.title = title.replace(/ — DeepSeek Harness$/, ' · ColdX');
        };
        brandTitle();
        const observer = new MutationObserver(brandTitle);
        observer.observe(document.head, { subtree: true, childList: true, characterData: true });
        // The native collapsed rail removes its visible settings text without
        // giving the icon button an accessible name. Keep the native action.
        const labeled = new Set();
        const labelSettings = () => {
          for (const button of document.querySelectorAll('button.VOzbGW_trigger')) if (!button.hasAttribute('aria-label')) {
            button.setAttribute('aria-label', '设置'); labeled.add(button);
          }
        };
        labelSettings();
        const controls = new MutationObserver(labelSettings);
        controls.observe(document.body, { childList: true, subtree: true });
        document.addEventListener('pointerdown', focusComposerSurface);
        return () => {
          observer.disconnect();
          controls.disconnect();
          document.removeEventListener('pointerdown', focusComposerSurface);
          for (const saved of previousIcons) if (saved.icon.getAttribute('href') === faviconHref) {
            if (saved.icon === createdIcon) saved.icon.remove();
            else for (const name of ['href', 'type', 'sizes']) {
              if (saved[name] === null) saved.icon.removeAttribute(name);
              else saved.icon.setAttribute(name, saved[name]);
            }
          }
          for (const button of labeled) if (button.getAttribute('aria-label') === '设置') button.removeAttribute('aria-label');
          style.remove();
          if (!alreadyStyled) document.documentElement.classList.remove('coldx-shell');
          if (document.title === 'ColdX · AI 工作台') document.title = previous;
        };
      });
    },
  };
}
