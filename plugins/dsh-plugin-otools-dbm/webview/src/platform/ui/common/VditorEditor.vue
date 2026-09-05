<template>
  <div class="vditor-wrapper" :style="wrapperStyle">
    <div ref="editorEl" class="vditor-host"></div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { ElMessage } from 'element-plus';
import { invoke, isTauri } from '@tauri-apps/api/core';
import Vditor from 'vditor';
import 'vditor/dist/index.css';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    height?: string | number;
    placeholder?: string;
    saveText?: string;
  }>(),
  {
    modelValue: '',
    height: '100%',
    placeholder: '',
    saveText: '保存'
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'save'): void;
}>();

const editorEl = ref<HTMLDivElement | null>(null);
let vditor: Vditor | null = null;
let lastValue = props.modelValue;
let syncing = false;
let themeObserver: MutationObserver | null = null;
let lastUploadNoticeAt = 0;
const isTauriRuntime = isTauri();

const wrapperStyle = computed(() => ({
  height: typeof props.height === 'number' ? `${props.height}px` : props.height
}));

const currentTheme = () => {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light';
};

const applyTheme = () => {
  if (!vditor || typeof (vditor as any).setTheme !== 'function') return;
  const theme = currentTheme();
  (vditor as any).setTheme(theme, theme, theme);
};

const notifyUploadBlocked = () => {
  const now = Date.now();
  if (now - lastUploadNoticeAt < 1200) return;
  lastUploadNoticeAt = now;
  ElMessage.warning('暂未提供图片托管服务，请自行上传图床');
};

interface MarkdownSavedImage {
  localPath: string;
  relativePath: string;
  staticUrl: string;
}

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
};

const buildImageLabel = (name: string, url: string) => {
  const alt = name || 'image';
  if (vditor?.getCurrentMode() === 'wysiwyg') {
    return `<img alt="${alt}" src="${url}">\n`;
  }
  return `![${alt}](${url})\n`;
};

const buildToolbar = () => [
  'emoji',
  'headings',
  'bold',
  'italic',
  'strike',
  'link',
  'list',
  'ordered-list',
  'check',
  'quote',
  'code',
  'inline-code',
  'table',
  'upload',
  {
    name: 'save',
    tip: props.saveText,
    hotkey: '⌘S',
    click: () => emit('save')
  },
  'edit-mode',
  'preview',
  'fullscreen'
];

onMounted(() => {
  if (!editorEl.value) return;
  vditor = new Vditor(editorEl.value, {
    height: wrapperStyle.value.height ?? '100%',
    value: props.modelValue ?? '',
    mode: 'ir',
    theme: currentTheme() == 'dark' ? 'dark' : 'classic',
    placeholder: props.placeholder,
    toolbar: buildToolbar(),
    preview: {
      markdown: {
        sanitize: false
      }
    },
    cache: { enable: false },
    upload: {
      accept: 'image/*',
      handler: async (files) => {
        if (!isTauriRuntime) {
          notifyUploadBlocked();
          return '暂未提供图片托管服务，请自行上传图床';
        }
        if (!vditor) {
          return '编辑器尚未就绪，请稍后重试';
        }
        if (!files || files.length === 0) {
          return '未检测到可上传的图片';
        }
        try {
          const inserts: string[] = [];
          for (const file of files) {
            if (!file) continue;
            if (file.type && !file.type.startsWith('image/')) {
              return '仅支持上传图片文件';
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            const dataBase64 = bytesToBase64(bytes);
            const savedImage = await invoke<MarkdownSavedImage>('upload_save_image', {
              fileName: file.name || 'image',
              mime: file.type || '',
              dataBase64,
              sourceModule: 'markdown'
            });
            inserts.push(buildImageLabel(file.name || 'image', savedImage.staticUrl));
          }
          if (inserts.length > 0) {
            vditor.insertValue(inserts.join(''), true);
          }
          return null;
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          ElMessage.error(`图片保存失败: ${message}`);
          return `图片保存失败: ${message}`;
        }
      }
    },
    input: (value) => {
      syncing = true;
      lastValue = value;
      emit('update:modelValue', value);
      syncing = false;
    },
    after: () => {
      lastValue = props.modelValue ?? '';
      applyTheme();
    }
  });

  if (typeof MutationObserver !== 'undefined') {
    themeObserver = new MutationObserver(() => {
      applyTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class']
    });
  }
});

watch(
  () => props.modelValue,
  (value) => {
    if (!vditor || syncing) return;
    const next = value ?? '';
    if (next === lastValue) return;
    lastValue = next;
    vditor.setValue(next);
  }
);

watch(
  () => props.height,
  (value) => {
    if (!vditor || typeof (vditor as any).setHeight !== 'function') return;
    const next = typeof value === 'number' ? `${value}px` : value || '100%';
    (vditor as any).setHeight(next);
  }
);

onBeforeUnmount(() => {
  if (themeObserver) {
    themeObserver.disconnect();
    themeObserver = null;
  }
  if (vditor && typeof (vditor as any).destroy === 'function') {
    (vditor as any).destroy();
  }
  vditor = null;
});
</script>

<style scoped>
.vditor-wrapper {
  width: 100%;
  min-height: 0;
}

.vditor-host {
  width: 100%;
  height: 100%;
}

:deep(.vditor) {
  height: 100%;
}
</style>
