// iOS Safari/PWA and WKWebView: follow the viewport while the keyboard is open.
(() => {
    const native = window.Capacitor?.getPlatform?.() === 'ios';
    const appleTouch = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
        navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
    if (!native && !appleTouch) return;
    const root = document.documentElement;
    root.classList.add('ios-layout');
    if (native) root.classList.add('native-ios');
    const viewport = window.visualViewport;
    let timer;
    const revealInput = () => {
        const field = document.activeElement;
        if (!field?.matches('input, textarea, [contenteditable="true"]')) return;
        field.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'auto' });
    };
    const update = () => {
        root.style.setProperty('--ios-visible-height', `${viewport?.height || innerHeight}px`);
        root.style.setProperty('--ios-visible-top', `${viewport?.offsetTop || 0}px`);
        // Ignore Safari zoom; input font size below prevents focus zoom.
        const keyboardOpen = (viewport?.scale || 1) === 1 && innerHeight - (viewport?.height || innerHeight) > 120 &&
            !!document.activeElement?.matches('input, textarea, [contenteditable="true"]');
        root.classList.toggle('ios-keyboard-open', keyboardOpen);
        clearTimeout(timer);
        if (keyboardOpen) timer = setTimeout(revealInput, 80);
    };
    viewport?.addEventListener('resize', update);
    viewport?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    document.addEventListener('focusin', update);
    document.addEventListener('focusout', () => setTimeout(update, 0));
    update();
})();
