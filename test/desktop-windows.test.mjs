import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { WindowsDesktopWorker, DesktopController } from '../plugin/desktop-control.mjs';

test('Windows helper compiles and answers a data-only capability probe', {skip:process.platform!=='win32',timeout:20000},async()=>{
  const worker=new WindowsDesktopWorker();try{const result=await worker.request({action:'probe'});assert.equal(result.available,true);assert.equal(result.backend,'windows-native');assert.ok([4,8].includes(result.pointerSize));}finally{await worker.stop();}
});

test('owned desktop window receives real click, Chinese typing, key and drag input', {skip:process.env.COLDX_DESKTOP_SMOKE!=='1'||process.platform!=='win32',timeout:40000},async()=>{
  const child=spawn(join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./fixtures/desktop-owned-window.ps1',import.meta.url))],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  const events=[];let diagnostics='';const lines=createInterface({input:child.stdout});lines.on('line',line=>{try{events.push(JSON.parse(line));}catch{}});child.stderr.on('data',chunk=>diagnostics+=chunk);
  const wait=async predicate=>{for(let i=0;i<100;i++){const value=events.find(predicate);if(value)return value;await delay(50);}throw new Error('Owned fixture timed out: '+diagnostics+' '+JSON.stringify([...events.filter(event=>event.event==='key'),...events.slice(-4)]));};
  const controller=new DesktopController();
  try{
    const {id}=await wait(event=>event.event==='ready');await controller.enable('owned-smoke');
    let state=await controller.act('owned-smoke',{action:'focus',windowId:id});
    const act=async request=>state=await controller.act('owned-smoke',{windowId:id,observationId:state.observation.id,...request});
    const point=name=>{const control=state.observation.controls.find(item=>item.name===name);assert.ok(control,'fixture accessibility control: '+name);return {x:Math.round(control.bounds.x+control.bounds.width/2),y:Math.round(control.bounds.y+control.bounds.height/2)};};
    await act({action:'click',...point('ColdX fixture button')});await wait(event=>event.event==='click');
    await act({action:'click',...point('ColdX fixture input')});
    await act({action:'type',text:'你好 ColdX'});await wait(event=>event.event==='text'&&event.text==='你好 ColdX');
    await act({action:'key',keys:['Control','A']});await act({action:'type',text:'Verified'});await wait(event=>event.event==='text'&&event.text==='Verified');
    const drag=point('ColdX fixture drag');await act({action:'drag',...drag,endX:drag.x+40,endY:drag.y+15});
    const event=await wait(event=>event.event==='drag');assert.ok(event.x>200);assert.ok(state.observation.previewAttachment.base64.length>1000);
    await act({action:'scroll',...point('ColdX fixture scroll'),deltaY:360});await wait(event=>event.event==='scroll'&&event.delta<0);
  }finally{await controller.dispose();child.kill();lines.close();}
});
