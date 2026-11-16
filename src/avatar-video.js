// Независимый HTML-видеоплеер: ошибки медиа не блокируют запуск приложения.
const video = document.getElementById('bodyScanVideo');
const status = document.getElementById('bodyScanStatus');
const button = document.getElementById('bodyScanPlay');

if (video && status && button) {
    const preview = document.querySelector('.avatar-video-preview');
    let visible = false;
    let pending = false;
    let failed = false;

    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;

    function showError() {
        failed = true;
        video.hidden = true;
        status.textContent = 'Статус: Видео недоступно — показано превью';
        button.textContent = 'Повторить загрузку';
        button.hidden = false;
    }

    async function play() {
        if (pending || failed || !visible || document.hidden) return;
        pending = true;
        try {
            await video.play();
        } catch (error) {
            if (failed || error.name === 'AbortError') return;
            if (error.name === 'NotSupportedError') {
                showError();
            } else {
                status.textContent = 'Статус: Нажмите для воспроизведения';
                button.textContent = 'Воспроизвести';
                button.hidden = false;
            }
        } finally {
            pending = false;
        }
    }

    function refresh() {
        visible = video.getClientRects().length > 0;
        if (document.hidden || !visible) video.pause();
        else void play();
    }

    preview?.addEventListener('error', () => { preview.hidden = true; });
    if (preview?.complete && !preview.naturalWidth) preview.hidden = true;
    video.addEventListener('error', showError);
    video.addEventListener('playing', () => {
        video.hidden = false;
        status.textContent = 'Статус: Синхронизировано ⚡️';
        button.hidden = true;
    });
    button.addEventListener('click', () => {
        if (failed) {
            failed = false;
            video.hidden = false;
            video.load();
        }
        refresh();
    });
    document.addEventListener('visibilitychange', refresh);
    window.addEventListener('pageshow', refresh);
    window.avatarVideo = { refresh };
    if (video.error) showError();
    else refresh();
}
