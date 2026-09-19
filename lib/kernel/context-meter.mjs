/** Non-mutating accounting of JSON request values. UTF-16 characters are not
 * model tokens. Weak keys memoize recursively immutable subtrees only. */
export class ContextMeter {
  constructor() { this.memo = new WeakMap(); }

  measure(request = {}) {
    let cacheHits = 0, visitedNodes = 0, work = 0, complete = true;
    // Enumerate incrementally: large arrays must never materialize a second
    // descriptor/value array. Each property/stack step spends the same budget.
    function* descriptors(value) {
      if (Array.isArray(value)) {
        for (let index = 0; index < value.length; index++) yield Object.getOwnPropertyDescriptor(value, index);
      } else {
        for (const key in value) yield Object.getOwnPropertyDescriptor(value, key);
      }
    }
    const count = root => {
      const path = new WeakSet(), stack = [{ value: root, entered: false }], result = { chars: 0, images: 0 };
      const finish = (value, immutable) => {
        const frame = stack.pop();
        if (frame.entered) {
          path.delete(frame.value);
          if (immutable) this.memo.set(frame.value, value);
        }
        const parent = stack.at(-1);
        if (parent) { parent.chars += value.chars; parent.images += value.images; parent.immutable &&= immutable; }
        else Object.assign(result, value);
      };
      while (stack.length) {
        if (++work > 200_000) {
          complete = false;
          // Unfinished frames contain disjoint completed children; don't cache
          // their partial totals or walk the unvisited remainder of the input.
          for (const frame of stack) { result.chars += frame.chars ?? 0; result.images += frame.images ?? 0; }
          return result;
        }
        const frame = stack.at(-1), value = frame.value;
        if (!frame.entered) {
          visitedNodes++;
          if (typeof value === 'string') { finish({ chars: value.length, images: 0 }, true); continue; }
          if (!value || typeof value !== 'object') { finish({ chars: 0, images: 0 }, true); continue; }
          const cached = this.memo.get(value);
          if (cached) { cacheHits++; finish(cached, true); continue; }
          if (path.has(value)) { complete = false; finish({ chars: 0, images: 0 }, false); continue; }
          const type = Object.getOwnPropertyDescriptor(value, 'type')?.value;
          if (type === 'image' || type === 'image_url' || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
            finish({ chars: 0, images: type ? 1 : 0 }, Object.isFrozen(value)); continue;
          }
          frame.children = descriptors(value);
          frame.immutable = Object.isFrozen(value);
          frame.entered = true; frame.chars = 0; frame.images = 0; path.add(value);
        }
        const next = frame.children.next();
        if (next.done) { finish({ chars: frame.chars, images: frame.images }, frame.immutable); continue; }
        const descriptor = next.value;
        if (!descriptor?.enumerable) continue;
        if (!('value' in descriptor)) { complete = false; frame.immutable = false; continue; }
        stack.push({ value: descriptor.value, entered: false });
      }
      return result;
    };
    const system = count(request.system), messages = count(request.messages), tools = count(request.tools);
    return { systemChars: system.chars, messageChars: messages.chars, toolChars: tools.chars,
      totalChars: system.chars + messages.chars + tools.chars,
      messageCount: Array.isArray(request.messages) ? request.messages.length : 0,
      toolCount: Array.isArray(request.tools) ? request.tools.length : 0,
      imageCount: messages.images, cacheHits, visitedNodes, complete };
  }
}
