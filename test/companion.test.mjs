import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanionComponents} from '../plugin/client/companion-source.mjs';

const create = () => createCompanionComponents({createElement() {}}, {}, '');
test('companion follows running and pending state without declaring a cancelled turn successful', () => {
  const pet = create();
  pet.observe({sessionId:'a',running:true});
  assert.equal(pet.getSnapshot().mood,'busy');
  pet.observe({sessionId:'a',running:true,pending:1});
  assert.equal(pet.getSnapshot().mood,'waiting');
  pet.observe({sessionId:'a',running:false});
  assert.equal(pet.getSnapshot().mood,'idle');
  assert.doesNotMatch(pet.getSnapshot().caption,/完成|成功/);
});
test('terminal errors get a gentle response, never a success celebration', () => {
  const pet=create();
  pet.observe({sessionId:'a',running:false,lastKind:'turn-error'});
  assert.equal(pet.getSnapshot().mood,'problem');
  pet.observe({sessionId:'a',running:true,lastKind:'turn-error'});
  assert.equal(pet.getSnapshot().mood,'busy','retry takes priority over old errors');
});
test('session ownership prevents stale unmounts from resetting another session', () => {
  const pet=create();
  pet.observe({sessionId:'a',running:true});
  pet.observe({sessionId:'b',running:true});
  pet.forget('a');
  assert.equal(pet.getSnapshot().mood,'busy');
  pet.forget('b');
  assert.equal(pet.getSnapshot().mood,'idle');
});
test('streaming identical state does not notify or allocate new snapshots', () => {
  const pet=create();let notices=0;
  const unsubscribe=pet.subscribe(()=>notices++);
  pet.observe({sessionId:'a',running:true});
  const before=pet.getSnapshot();
  for(let i=0;i<100;i++)pet.observe({sessionId:'a',running:true});
  assert.equal(pet.getSnapshot(),before);assert.equal(notices,1);
  unsubscribe();pet.forget('a');assert.equal(notices,1);
});
test('petting never masks waiting or failed execution state', () => {
  const pet=create();
  for(const mood of ['busy','waiting','problem']) {
    assert.equal(pet.petCaption(mood,2),pet.labels[mood]);
  }
  assert.notEqual(pet.petCaption('idle',0),pet.petCaption('idle',1));
});
