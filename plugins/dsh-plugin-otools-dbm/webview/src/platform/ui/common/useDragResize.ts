import { onBeforeUnmount, ref } from 'vue';

type DragAxis = 'x' | 'y';

type LimitValue = number | (() => number);

interface DragResizeState {
  startX: number;
  startY: number;
  startValue: number;
}

interface DragResizeOptions {
  axis: DragAxis;
  min: LimitValue;
  max: LimitValue;
  getInitialValue: () => number;
  onChange: (value: number) => void;
  cursor?: string;
  getValueFromPointer?: (event: PointerEvent, state: DragResizeState) => number;
  onStart?: (state: DragResizeState, event: PointerEvent) => void;
  onEnd?: () => void;
}

const resolveLimit = (value: LimitValue) => (typeof value === 'function' ? value() : value);

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

export const useDragResize = (options: DragResizeOptions) => {
  const dragging = ref(false);
  const state: DragResizeState = {
    startX: 0,
    startY: 0,
    startValue: 0,
  };
  let previousCursor = '';
  let activeTarget: HTMLElement | null = null;
  let activePointerId: number | null = null;

  const stopDragging = () => {
    if (!dragging.value) return;
    dragging.value = false;
    document.body.style.cursor = previousCursor;
    document.removeEventListener('pointermove', handlePointerMove);
    document.removeEventListener('pointerup', stopDragging);
    document.removeEventListener('pointercancel', stopDragging);
    document.removeEventListener('lostpointercapture', stopDragging, true);
    if (activeTarget && activePointerId !== null) {
      try {
        if (activeTarget.hasPointerCapture?.(activePointerId)) {
          activeTarget.releasePointerCapture?.(activePointerId);
        }
      } catch {
        // ignore pointer capture release errors
      }
    }
    activeTarget = null;
    activePointerId = null;
    options.onEnd?.();
  };

  const handlePointerMove = (event: PointerEvent) => {
    if (!dragging.value) return;
    const min = resolveLimit(options.min);
    const max = resolveLimit(options.max);
    let nextValue = state.startValue;
    if (options.getValueFromPointer) {
      nextValue = options.getValueFromPointer(event, state);
    } else {
      const delta = options.axis === 'x' ? event.clientX - state.startX : event.clientY - state.startY;
      nextValue = state.startValue + delta;
    }
    options.onChange(clamp(nextValue, min, max));
  };

  const startDragging = (event: PointerEvent) => {
    if (event.button !== 0) return;
    dragging.value = true;
    state.startX = event.clientX;
    state.startY = event.clientY;
    state.startValue = options.getInitialValue();
    options.onStart?.(state, event);
    previousCursor = document.body.style.cursor;
    document.body.style.cursor = options.cursor ?? (options.axis === 'x' ? 'col-resize' : 'row-resize');
    document.addEventListener('pointermove', handlePointerMove);
    document.addEventListener('pointerup', stopDragging);
    document.addEventListener('pointercancel', stopDragging);
    document.addEventListener('lostpointercapture', stopDragging, true);
    const target = event.currentTarget as HTMLElement | null;
    activeTarget = target;
    activePointerId = event.pointerId;
    target?.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  };

  onBeforeUnmount(() => {
    stopDragging();
  });

  return {
    dragging,
    startDragging,
  };
};
