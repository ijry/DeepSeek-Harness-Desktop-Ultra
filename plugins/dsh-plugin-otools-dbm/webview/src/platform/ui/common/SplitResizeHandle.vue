<template>
  <div
    class="split-resize-handle"
    :class="[`is-${axis}`, { dragging, disabled }]"
    @pointerdown="handlePointerDown"
  />
</template>

<script setup lang="ts">
const props = withDefaults(defineProps<{
  axis?: 'x' | 'y';
  dragging?: boolean;
  disabled?: boolean;
}>(), {
  axis: 'x',
  dragging: false,
  disabled: false,
});

const emit = defineEmits<{
  (e: 'pointerdown', event: PointerEvent): void;
}>();

const handlePointerDown = (event: PointerEvent) => {
  if (props.disabled) {
    return;
  }
  emit('pointerdown', event);
};
</script>

<style scoped>
.split-resize-handle {
  position: relative;
  flex-shrink: 0;
  background: transparent;
  user-select: none;
  touch-action: none;
  z-index: 5;
}

.split-resize-handle.is-x {
  width: 10px;
  margin: 0 4px;
  cursor: col-resize;
}

.split-resize-handle.is-y {
  height: 10px;
  margin: 4px 0;
  cursor: row-resize;
}

.split-resize-handle.is-x::before,
.split-resize-handle.is-y::before {
  content: '';
  position: absolute;
  background: var(--layout-border-color);
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
}

.split-resize-handle.is-x::before {
  top: 0;
  bottom: 0;
  left: 50%;
  width: 1px;
  transform: translateX(-50%);
}

.split-resize-handle.is-y::before {
  left: 0;
  right: 0;
  top: 50%;
  height: 1px;
  transform: translateY(-50%);
}

.split-resize-handle:hover::before,
.split-resize-handle.dragging::before {
  background: color-mix(in srgb, var(--el-color-primary) 72%, white 28%);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--el-color-primary) 14%, transparent);
}

.split-resize-handle.disabled {
  pointer-events: none;
  opacity: 0.45;
}
</style>
