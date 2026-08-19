
/* global SillyTavern */
import mermaid from 'mermaid';
import './style.css';

const {
    eventSource,
    event_types,
} = SillyTavern.getContext();

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 8;
const ZOOM_FACTOR = 1.25;
const viewers = new Set();
let activeModalViewer = null;
let resizeFrame = 0;

const events = [
    event_types.CHARACTER_MESSAGE_RENDERED,
    event_types.USER_MESSAGE_RENDERED,
    event_types.CHAT_CHANGED,
    event_types.MESSAGE_SWIPED,
    event_types.MESSAGE_UPDATED,
];

// Set event listeners for chat events.
for (const event of events) {
    eventSource.on(event, renderMermaidCharts);
}

/**
 * Renders newly added Mermaid code blocks and equips their SVGs with a passive
 * preview that opens an interactive zoom and pan window.
 * @returns {Promise<void>}
 */
async function renderMermaidCharts() {
    if (activeModalViewer && !activeModalViewer.isPlaceholderConnected()) {
        activeModalViewer.closeModal(false);
    }

    const blocks = Array.from(document.querySelectorAll('#chat pre code'));
    const nodes = [];
    for (const block of blocks) {
        if (block.classList.contains('custom-language-mermaid') || block.classList.contains('language-mermaid')) {
            const parent = block.parentElement;
            parent.classList.add('mermaid');
            parent.querySelector('.code-copy')?.remove();
            parent.innerHTML = block.innerHTML;
            nodes.push(parent);
        }
    }

    const chatElement = document.getElementById('chat');
    if (!chatElement) {
        return;
    }

    const chatHeight = chatElement.scrollHeight;

    if (nodes.length > 0) {
        await mermaid.run({ nodes });
        nodes.forEach(enhanceMermaidChart);
    }

    const scrollPosition = chatElement.scrollTop;
    const newChatHeight = chatElement.scrollHeight;
    const diff = newChatHeight - chatHeight;
    chatElement.scrollTop = scrollPosition + diff;
}

/**
 * Adds a passive inline preview and interactive modal around a Mermaid SVG.
 * @param {HTMLElement} viewer Rendered Mermaid container.
 * @returns {void}
 */
function enhanceMermaidChart(viewer) {
    if (viewer.classList.contains('mermaid-viewer')) {
        return;
    }

    const svg = viewer.querySelector(':scope > svg');
    if (!svg) {
        return;
    }

    const initialRect = svg.getBoundingClientRect();
    const viewBox = svg.viewBox?.baseVal;
    const naturalWidth = viewBox?.width || initialRect.width || 1;
    const naturalHeight = viewBox?.height || initialRect.height || 1;

    viewer.classList.add('mermaid-viewer');
    viewer.setAttribute('data-mermaid-interactive', 'true');

    const toolbar = document.createElement('div');
    toolbar.className = 'mermaid-toolbar';
    toolbar.setAttribute('role', 'toolbar');
    toolbar.setAttribute('aria-label', 'Mermaid diagram controls');

    const zoomOutButton = createControl('Zoom out', '−', 'zoom-out');
    const zoomValue = document.createElement('output');
    zoomValue.className = 'mermaid-zoom-value';
    zoomValue.setAttribute('aria-live', 'polite');
    zoomValue.setAttribute('aria-label', 'Diagram zoom');
    const zoomInButton = createControl('Zoom in', '+', 'zoom-in');
    const resetButton = createControl('Fit diagram in window', '↺', 'reset');
    const closeButton = createControl('Close diagram', '×', 'close');
    toolbar.append(zoomOutButton, zoomValue, zoomInButton, resetButton, closeButton);

    const viewport = document.createElement('div');
    viewport.className = 'mermaid-viewport';
    viewport.tabIndex = 0;
    viewport.setAttribute('role', 'button');
    viewport.setAttribute('aria-label', 'Open interactive Mermaid diagram');
    viewport.setAttribute('aria-expanded', 'false');

    const surface = document.createElement('div');
    surface.className = 'mermaid-surface';
    svg.classList.add('mermaid-diagram');
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.removeProperty('max-width');
    surface.append(svg);

    const openHint = document.createElement('span');
    openHint.className = 'mermaid-open-hint';
    openHint.setAttribute('aria-hidden', 'true');
    openHint.textContent = 'Tap to zoom and pan';

    viewport.append(surface, openHint);
    viewer.replaceChildren(toolbar, viewport);

    const state = {
        scale: 1,
        baseWidth: initialRect.width || naturalWidth,
        baseHeight: initialRect.height || naturalHeight,
        modal: false,
        overlay: null,
        placeholder: null,
        previousFocus: null,
        pointers: new Map(),
        gesture: null,
        suppressClickUntil: 0,
    };

    /**
     * Returns the diagram's current size and offset inside its scroll surface.
     * @returns {{ width: number, height: number, offsetX: number, offsetY: number }}
     */
    function getDiagramMetrics() {
        const width = state.baseWidth * state.scale;
        const height = state.baseHeight * state.scale;
        return {
            width,
            height,
            offsetX: Math.max(0, (surface.clientWidth - width) / 2),
            offsetY: Math.max(0, (surface.clientHeight - height) / 2),
        };
    }

    /**
     * Captures the diagram coordinate under a viewport-relative point.
     * @param {number} x Horizontal point inside the viewport.
     * @param {number} y Vertical point inside the viewport.
     * @returns {{ x: number, y: number, u: number, v: number }}
     */
    function captureAnchor(x, y) {
        const metrics = getDiagramMetrics();
        return {
            x,
            y,
            u: (viewport.scrollLeft + x - metrics.offsetX) / metrics.width,
            v: (viewport.scrollTop + y - metrics.offsetY) / metrics.height,
        };
    }

    /**
     * Restores a captured diagram coordinate beneath its viewport point.
     * @param {{ x: number, y: number, u: number, v: number }} anchor Diagram anchor.
     * @returns {void}
     */
    function restoreAnchor(anchor) {
        const metrics = getDiagramMetrics();
        viewport.scrollLeft = metrics.offsetX + (anchor.u * metrics.width) - anchor.x;
        viewport.scrollTop = metrics.offsetY + (anchor.v * metrics.height) - anchor.y;
    }

    /**
     * Applies current dimensions and updates control state.
     * @returns {void}
     */
    function applyGeometry() {
        const width = state.baseWidth * state.scale;
        const height = state.baseHeight * state.scale;
        svg.style.width = `${width}px`;
        svg.style.height = `${height}px`;
        surface.style.width = `${Math.max(viewport.clientWidth, width + 20)}px`;
        surface.style.height = `${Math.max(viewport.clientHeight, height + 20)}px`;
        zoomValue.value = `${Math.round(state.scale * 100)}%`;
        zoomValue.textContent = zoomValue.value;
        zoomOutButton.disabled = state.scale <= MIN_ZOOM;
        zoomInButton.disabled = state.scale >= MAX_ZOOM;
    }

    /**
     * Changes zoom while keeping the selected point visually stationary.
     * @param {number} nextScale Requested zoom scale.
     * @param {number} [x] Horizontal focal point inside the viewport.
     * @param {number} [y] Vertical focal point inside the viewport.
     * @returns {void}
     */
    function setZoom(nextScale, x = viewport.clientWidth / 2, y = viewport.clientHeight / 2) {
        if (!state.modal) {
            return;
        }

        const scale = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, nextScale));
        if (Math.abs(scale - state.scale) < 0.001) {
            return;
        }

        const anchor = captureAnchor(x, y);
        state.scale = scale;
        applyGeometry();
        restoreAnchor(anchor);
    }

    /**
     * Fits the diagram inside either the inline preview or modal viewport.
     * @param {boolean} [resetScale=true] Whether to reset zoom and scroll position.
     * @returns {void}
     */
    function reflow(resetScale = true) {
        const availableWidth = Math.max(1, (viewport.clientWidth || viewer.clientWidth || initialRect.width) - 20);
        const previewLimit = Math.min(320, Math.max(150, window.innerHeight * 0.34));
        const availableHeight = state.modal
            ? Math.max(1, viewport.clientHeight - 20)
            : previewLimit;
        const fitScale = Math.min(1, availableWidth / naturalWidth, availableHeight / naturalHeight);

        state.baseWidth = naturalWidth * fitScale;
        state.baseHeight = naturalHeight * fitScale;

        if (!state.modal) {
            viewport.style.height = `${Math.min(previewLimit + 20, state.baseHeight + 20)}px`;
        } else {
            viewport.style.removeProperty('height');
        }

        if (resetScale) {
            state.scale = 1;
        }

        applyGeometry();
        if (resetScale) {
            viewport.scrollTo(0, 0);
        }
    }

    /**
     * Closes the interactive window and optionally restores the inline preview.
     * @param {boolean} [restore=true] Whether to restore the viewer at its placeholder.
     * @returns {void}
     */
    function closeModal(restore = true) {
        if (!state.modal) {
            return;
        }

        state.modal = false;
        viewer.classList.remove('mermaid-viewer-modal');
        viewport.setAttribute('role', 'button');
        viewport.setAttribute('aria-label', 'Open interactive Mermaid diagram');
        viewport.setAttribute('aria-expanded', 'false');
        document.body.classList.remove('mermaid-viewer-modal-open');
        state.overlay?.remove();

        if (restore && state.placeholder?.isConnected) {
            state.placeholder.replaceWith(viewer);
        } else {
            viewer.remove();
        }

        state.overlay = null;
        state.placeholder = null;
        state.pointers.clear();
        state.gesture = null;
        activeModalViewer = null;

        if (restore) {
            requestAnimationFrame(() => {
                reflow(true);
                if (state.previousFocus instanceof HTMLElement) {
                    state.previousFocus.focus({ preventScroll: true });
                }
            });
        } else {
            viewers.delete(controller);
        }
    }

    /**
     * Moves the original SVG into a compact, body-level interactive window.
     * @returns {void}
     */
    function openModal() {
        if (state.modal) {
            return;
        }

        activeModalViewer?.closeModal();
        state.previousFocus = document.activeElement;
        state.placeholder = document.createElement('div');
        state.placeholder.className = 'mermaid-preview-placeholder';
        state.placeholder.style.height = `${viewer.getBoundingClientRect().height}px`;
        viewer.replaceWith(state.placeholder);

        state.overlay = document.createElement('div');
        state.overlay.className = 'mermaid-modal-overlay';
        state.overlay.setAttribute('role', 'dialog');
        state.overlay.setAttribute('aria-modal', 'true');
        state.overlay.setAttribute('aria-label', 'Interactive Mermaid diagram');
        state.overlay.addEventListener('click', event => {
            if (event.target === state.overlay) {
                closeModal();
            }
        });
        state.overlay.append(viewer);
        document.body.append(state.overlay);

        state.modal = true;
        activeModalViewer = controller;
        viewer.classList.add('mermaid-viewer-modal');
        viewport.setAttribute('role', 'group');
        viewport.setAttribute('aria-label', 'Interactive Mermaid diagram. Drag to pan, pinch or use the controls to zoom.');
        viewport.setAttribute('aria-expanded', 'true');
        document.body.classList.add('mermaid-viewer-modal-open');

        requestAnimationFrame(() => {
            reflow(true);
            viewport.focus({ preventScroll: true });
        });
    }

    zoomOutButton.addEventListener('click', () => setZoom(state.scale / ZOOM_FACTOR));
    zoomInButton.addEventListener('click', () => setZoom(state.scale * ZOOM_FACTOR));
    resetButton.addEventListener('click', () => reflow(true));
    closeButton.addEventListener('click', () => closeModal());

    viewport.addEventListener('wheel', event => {
        if (!state.modal || (!event.ctrlKey && !event.metaKey)) {
            return;
        }

        event.preventDefault();
        const rect = viewport.getBoundingClientRect();
        const factor = Math.exp(-event.deltaY * 0.002);
        setZoom(state.scale * factor, event.clientX - rect.left, event.clientY - rect.top);
    }, { passive: false });

    viewport.addEventListener('keydown', event => {
        if (!state.modal) {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openModal();
            }
            return;
        }

        const panDistance = event.shiftKey ? 120 : 40;
        switch (event.key) {
            case '+':
            case '=':
                event.preventDefault();
                setZoom(state.scale * ZOOM_FACTOR);
                break;
            case '-':
            case '_':
                event.preventDefault();
                setZoom(state.scale / ZOOM_FACTOR);
                break;
            case '0':
                event.preventDefault();
                reflow(true);
                break;
            case 'ArrowLeft':
                event.preventDefault();
                viewport.scrollLeft -= panDistance;
                break;
            case 'ArrowRight':
                event.preventDefault();
                viewport.scrollLeft += panDistance;
                break;
            case 'ArrowUp':
                event.preventDefault();
                viewport.scrollTop -= panDistance;
                break;
            case 'ArrowDown':
                event.preventDefault();
                viewport.scrollTop += panDistance;
                break;
            case 'Escape':
                event.preventDefault();
                closeModal();
                break;
        }
    });

    viewport.addEventListener('click', event => {
        if (!state.modal) {
            event.preventDefault();
            openModal();
            return;
        }

        if (Date.now() < state.suppressClickUntil) {
            event.preventDefault();
            event.stopPropagation();
        }
    }, true);

    viewport.addEventListener('pointerdown', event => {
        if (!state.modal || (event.pointerType === 'mouse' && event.button !== 0)) {
            return;
        }

        state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        try {
            viewport.setPointerCapture(event.pointerId);
        } catch {
            // Synthetic pointer events used by some test runners do not have an active native pointer.
        }

        if (state.pointers.size === 1) {
            state.gesture = {
                type: 'pan',
                pointerId: event.pointerId,
                x: event.clientX,
                y: event.clientY,
                scrollLeft: viewport.scrollLeft,
                scrollTop: viewport.scrollTop,
                moved: false,
            };
        } else {
            const [first, second] = Array.from(state.pointers.values());
            state.gesture = {
                type: 'pinch',
                distance: Math.hypot(second.x - first.x, second.y - first.y),
            };
        }

        viewport.classList.add('mermaid-viewport-interacting');
    });

    viewport.addEventListener('pointermove', event => {
        if (!state.modal || !state.pointers.has(event.pointerId)) {
            return;
        }

        state.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
        if (state.pointers.size >= 2) {
            event.preventDefault();
            const [first, second] = Array.from(state.pointers.values());
            const distance = Math.hypot(second.x - first.x, second.y - first.y);
            const centerX = (first.x + second.x) / 2;
            const centerY = (first.y + second.y) / 2;
            const rect = viewport.getBoundingClientRect();
            const previousDistance = state.gesture?.type === 'pinch' ? state.gesture.distance : distance;
            if (previousDistance > 0) {
                setZoom(state.scale * (distance / previousDistance), centerX - rect.left, centerY - rect.top);
            }
            state.gesture = { type: 'pinch', distance };
            return;
        }

        if (state.gesture?.type === 'pan' && state.gesture.pointerId === event.pointerId) {
            const deltaX = event.clientX - state.gesture.x;
            const deltaY = event.clientY - state.gesture.y;
            if (Math.hypot(deltaX, deltaY) > 4) {
                state.gesture.moved = true;
                event.preventDefault();
            }
            viewport.scrollLeft = state.gesture.scrollLeft - deltaX;
            viewport.scrollTop = state.gesture.scrollTop - deltaY;
        }
    });

    const finishPointer = event => {
        if (!state.modal) {
            return;
        }

        const moved = state.gesture?.type === 'pan' && state.gesture.moved;
        state.pointers.delete(event.pointerId);
        if (moved) {
            state.suppressClickUntil = Date.now() + 250;
        }

        if (state.pointers.size === 1) {
            const [pointerId, pointer] = Array.from(state.pointers.entries())[0];
            state.gesture = {
                type: 'pan',
                pointerId,
                x: pointer.x,
                y: pointer.y,
                scrollLeft: viewport.scrollLeft,
                scrollTop: viewport.scrollTop,
                moved: false,
            };
        } else if (state.pointers.size === 0) {
            state.gesture = null;
            viewport.classList.remove('mermaid-viewport-interacting');
        }
    };

    viewport.addEventListener('pointerup', finishPointer);
    viewport.addEventListener('pointercancel', finishPointer);

    const controller = {
        viewer,
        reflow,
        closeModal,
        isPlaceholderConnected: () => Boolean(state.placeholder?.isConnected),
    };

    viewers.add(controller);
    requestAnimationFrame(() => reflow(true));
}

/**
 * Creates a toolbar button.
 * @param {string} label Accessible label and tooltip.
 * @param {string} text Visible button text.
 * @param {string} action Stable action identifier.
 * @returns {HTMLButtonElement}
 */
function createControl(label, text, action) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'mermaid-control';
    button.dataset.action = action;
    button.title = label;
    button.setAttribute('aria-label', label);
    button.textContent = text;
    return button;
}

window.addEventListener('resize', () => {
    cancelAnimationFrame(resizeFrame);
    resizeFrame = requestAnimationFrame(() => {
        for (const controller of viewers) {
            if (!controller.viewer.isConnected) {
                viewers.delete(controller);
                continue;
            }
            controller.reflow(false);
        }
    });
});

jQuery(() => {
    mermaid.initialize({
        theme: 'dark',
        startOnLoad: false,
        securityLevel: 'loose',
    });
});
