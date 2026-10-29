// Legacy card pages submit through these SillyTavern DOM IDs. Keep the
// adapter inside its owning frame so it cannot target another conversation.
function installLegacyTavernComposer() {
  if (document.getElementById('send_textarea') || document.getElementById('send_but')) return;
  const controls = document.createElement('div');
  controls.hidden = true;
  const area = document.createElement('textarea');
  area.id = 'send_textarea';
  const button = document.createElement('button');
  button.id = 'send_but';
  button.type = 'button';
  controls.append(area, button);
  document.body.append(controls);
  function fillInput() {
    Promise.resolve().then(function () {
      if (typeof window.triggerSlash !== 'function') throw new Error('当前对话输入框尚未就绪');
      return window.triggerSlash('/setinput ' + String(area.value || ''));
    }).catch(function (error) {
      const notice = document.createElement('div');
      notice.setAttribute('role', 'alert');
      notice.textContent = '开场文字填入失败：' + String(error && error.message || error);
      document.body.append(notice);
    });
  }
  area.addEventListener('input', fillInput);
  area.addEventListener('change', fillInput);
  let pending = false;
  button.addEventListener('click', function () {
    const text = String(area.value || '').trim();
    if (pending || !text) return;
    if (typeof window.triggerSlash !== 'function') throw new Error('当前对话发送入口尚未就绪');
    pending = true;
    button.disabled = true;
    Promise.resolve().then(function () {
      return window.triggerSlash('/send ' + text + '|/trigger');
    }).then(function () {
      if (area.value.trim() === text) area.value = '';
    }, function (error) {
      // A DOM click cannot return an asynchronous rejection to legacy callers.
      // Surface it in the card itself, retaining the payload for a retry.
      const notice = document.createElement('div');
      notice.setAttribute('role', 'alert');
      notice.textContent = '开局消息发送失败：' + String(error && error.message || error);
      document.body.append(notice);
      console.error('[DSH Tavern] 开局消息发送失败', error);
    }).finally(function () { pending = false; button.disabled = false; });
  });
}

// Preparation pages address the parent DOM. Own these controls only while that
// preview is mounted; they must never forward a submission to the current chat.
function installOpeningHostComposer(hostDocument, submit, report) {
  if (hostDocument.getElementById('send_textarea') || hostDocument.getElementById('send_but')) return function () {};
  const controls = hostDocument.createElement('div');
  controls.hidden = true;
  const area = hostDocument.createElement('textarea');
  area.id = 'send_textarea';
  const button = hostDocument.createElement('button');
  button.id = 'send_but'; button.type = 'button';
  controls.append(area, button);
  hostDocument.body.append(controls);
  let active = true, pending = false, completed = false;
  button.addEventListener('click', function () {
    const text = String(area.value || '').trim();
    if (!active || pending || completed || !text) return;
    pending = true; button.disabled = true;
    Promise.resolve().then(function () { return submit(text); }).then(function () {
      completed = true; area.value = '';
    }, report).finally(function () { pending = false; button.disabled = completed; });
  });
  return function () { active = false; controls.remove(); };
}

// Parent DOM IDs are shared, but the focused iframe identifies the sender even
// after document.write replaces its document. Never fall back to the active chat.
const tavernHostComposers = new WeakMap();
function installFrameHostComposer(doc, ownsFrame, submit, report, fill, read) {
  let state = tavernHostComposers.get(doc);
  // The player-visible composer is shared by every mounted card of the host
  // document. Native regexes focus the offscreen textarea (moving focus out of
  // the iframe) before they click #send_but, so the last card that held focus
  // identifies the sender when no frame is focused any more.
  function resolveOwner(allowFallback) {
    const owners = Array.from(state.owners);
    if (!owners.length) throw new Error('卡片页面尚未就绪，请稍后再试');
    const focused = owners.filter(function (owner) { return owner.ownsFrame(doc.activeElement); });
    if (focused.length === 1) { state.lastOwner = focused[0]; return focused[0]; }
    if (state.lastOwner && state.owners.has(state.lastOwner)) return state.lastOwner;
    if (owners.length === 1) { state.lastOwner = owners[0]; return owners[0]; }
    if (allowFallback) {
      // Draft sync is conversation-wide, so any mounted owner can read or fill
      // it; sending still requires an unambiguous focused frame.
      state.lastOwner = owners[owners.length - 1];
      return state.lastOwner;
    }
    throw new Error('无法确定输入框所属的卡片，请重新点击卡片内的选项');
  }
  function sync() {
    if (!state.area) return;
    let owner;
    try { owner = resolveOwner(true); } catch (_) { return; }
    if (typeof owner.read !== 'function') return;
    try {
      const value = owner.read();
      if (typeof value === 'string' && state.area.value !== value) state.area.value = value;
    } catch (_) {}
  }
  function commit() {
    if (!state.area) return;
    let owner;
    try { owner = resolveOwner(true); } catch (error) { report(error); return; }
    if (typeof owner.fill !== 'function') return;
    try { Promise.resolve(owner.fill(String(state.area.value || ''))).catch(owner.report); }
    catch (error) { owner.report(error); }
  }
  if (!state) {
    if (doc.getElementById('send_textarea') || doc.getElementById('send_but')) return function () {};
    const controls = doc.createElement('div');
    // Native regexes call focus() before reading #send_textarea.value. A
    // hidden element cannot take focus, so park the controls offscreen
    // instead of using the hidden attribute.
    controls.setAttribute('aria-hidden', 'true');
    controls.setAttribute('style', 'position:fixed;left:-10000px;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;');
    const area = doc.createElement('textarea'), button = doc.createElement('button');
    // Card scripts focus() this field programmatically; on phones that would pop
    // the soft keyboard for an invisible box, so ask for no virtual keyboard.
    area.id = 'send_textarea'; area.tabIndex = -1; area.setAttribute('inputmode', 'none'); button.id = 'send_but'; button.type = 'button';
    controls.append(area, button); doc.body.append(controls);
    state = { controls, area, owners: new Set(), lastOwner: null };
    tavernHostComposers.set(doc, state);
    // Native tavern regexes focus #send_textarea, read its value, append their
    // option text and fire input. Mirror the live draft on focus so append mode
    // keeps whatever the player already typed; input writes it back.
    area.addEventListener('focus', sync);
    // jQuery's .trigger('input') never dispatches a native event; it only runs
    // jQuery-bound handlers and the element's on<event> property. Use the
    // property so jQuery-triggered and native events each commit exactly once.
    area.oninput = commit;
    area.onchange = commit;
    function noteFrameFocus(event) {
      for (const owner of state.owners) if (owner.ownsFrame(event.target)) state.lastOwner = owner;
    }
    if (typeof doc.addEventListener === 'function') {
      doc.addEventListener('focusin', noteFrameFocus);
      // focusout fires on the iframe before focus reaches the offscreen textarea.
      doc.addEventListener('focusout', noteFrameFocus);
    }
    state.cleanup = function () {
      if (typeof doc.removeEventListener !== 'function') return;
      doc.removeEventListener('focusin', noteFrameFocus);
      doc.removeEventListener('focusout', noteFrameFocus);
    };
    button.addEventListener('click', function () {
      let owner;
      try { owner = resolveOwner(); } catch (error) { report(error); return; }
      const text = String(area.value || '').trim();
      if (owner.pending || !text) return;
      owner.pending = true;
      Promise.resolve().then(function () {
        if (!state.owners.has(owner)) throw new Error('卡片已关闭，请重新打开');
        return owner.submit(text);
      }).then(function () { if (area.value === text) area.value = ''; }, owner.report)
        .finally(function () { owner.pending = false; });
    });
  }
  const owner = { ownsFrame, submit, report, fill, read, pending: false };
  state.owners.add(owner);
  return function () {
    state.owners.delete(owner);
    if (state.lastOwner === owner) state.lastOwner = null;
    if (!state.owners.size) {
      if (typeof state.cleanup === 'function') state.cleanup();
      state.controls.remove();
      tavernHostComposers.delete(doc);
    }
  };
}
