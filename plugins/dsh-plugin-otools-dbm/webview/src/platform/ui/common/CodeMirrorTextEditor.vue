<template>
  <div ref="editorRef" class="code-mirror-text-editor"></div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
  placeholder as editorPlaceholder,
} from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { javascript } from '@codemirror/lang-javascript';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { php } from '@codemirror/lang-php';
import { sql, MySQL } from '@codemirror/lang-sql';
import { oneDark } from '@codemirror/theme-one-dark';

const props = withDefaults(
  defineProps<{
    modelValue: string;
    filePath?: string;
    disabled?: boolean;
    placeholder?: string;
  }>(),
  {
    filePath: '',
    disabled: false,
    placeholder: '',
  }
);

const emit = defineEmits<{
  (e: 'update:modelValue', value: string): void;
  (e: 'save-requested'): void;
}>();

const editorRef = ref<HTMLDivElement | null>(null);
let editor: EditorView | null = null;
let syncingFromEditor = false;
let themeObserver: MutationObserver | null = null;
const languageCompartment = new Compartment();
const readOnlyCompartment = new Compartment();
const editableCompartment = new Compartment();
const placeholderCompartment = new Compartment();
const themeCompartment = new Compartment();

const buildLanguageSupport = (filePath: string): Extension => {
  const extension = filePath.split('.').pop()?.toLowerCase() || '';

  switch (extension) {
    case 'js':
    case 'jsx':
    case 'ts':
    case 'tsx':
      return javascript({ jsx: true, typescript: extension.includes('ts') });
    case 'html':
    case 'htm':
    case 'vue':
    case 'xml':
    case 'svg':
      return html();
    case 'css':
    case 'scss':
    case 'sass':
    case 'less':
      return css();
    case 'json':
      return json();
    case 'py':
      return python();
    case 'php':
      return php();
    case 'sql':
      return sql({ dialect: MySQL });
    default:
      return [];
  }
};

const isDarkMode = () => {
  if (typeof document === 'undefined') {
    return false;
  }

  return document.documentElement.classList.contains('dark');
};

const lightTheme = EditorView.theme(
  {
    '&': {
      color: '#1f2328',
      backgroundColor: '#ffffff',
    },
    '.cm-content': {
      caretColor: '#2370c6',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#2370c6',
    },
    '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
      backgroundColor: 'rgba(35, 112, 198, 0.18)',
    },
    '.cm-activeLine': {
      backgroundColor: 'rgba(35, 112, 198, 0.06)',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#f7f9fc',
    },
    '.cm-gutters': {
      color: '#8a94a6',
      backgroundColor: '#f7f9fc',
      borderRight: '1px solid #edf1f7',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      color: '#97a1b3',
    },
    '.cm-placeholder': {
      color: '#a0a8b8',
    },
    '&.cm-focused': {
      outline: 'none',
    },
    '.cm-tooltip': {
      border: '1px solid var(--layout-border-color)',
      backgroundColor: 'var(--el-bg-color-overlay)',
    },
  },
  { dark: false }
);

const buildThemeExtension = (): Extension =>
  isDarkMode()
    ? oneDark
    : [lightTheme, syntaxHighlighting(defaultHighlightStyle, { fallback: true })];

const buildExtensions = (): Extension[] => {
  const extensions: Extension[] = [
    keymap.of([
      indentWithTab,
      {
        key: 'Mod-s',
        run: () => {
          emit('save-requested');
          return true;
        },
      },
    ]),
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    EditorView.lineWrapping,
    readOnlyCompartment.of(EditorState.readOnly.of(props.disabled)),
    editableCompartment.of(EditorView.editable.of(!props.disabled)),
    placeholderCompartment.of(props.placeholder ? editorPlaceholder(props.placeholder) : []),
    languageCompartment.of(buildLanguageSupport(props.filePath)),
    themeCompartment.of(buildThemeExtension()),
    EditorView.updateListener.of((update) => {
      if (!update.docChanged) {
        return;
      }

      syncingFromEditor = true;
      emit('update:modelValue', update.state.doc.toString());
      queueMicrotask(() => {
        syncingFromEditor = false;
      });
    }),
  ];
  return extensions;
};

const reconfigure = (compartment: Compartment, extension: Extension) => {
  if (!editor) {
    return;
  }

  editor.dispatch({
    effects: compartment.reconfigure(extension),
  });
};

const syncTheme = () => {
  reconfigure(themeCompartment, buildThemeExtension());
};

const createEditor = () => {
  if (!editorRef.value) {
    return;
  }

  editor?.destroy();
  editor = new EditorView({
    state: EditorState.create({
      doc: props.modelValue,
      extensions: buildExtensions(),
    }),
    parent: editorRef.value,
  });
};

watch(
  () => props.modelValue,
  (value) => {
    if (!editor || syncingFromEditor) {
      return;
    }

    const currentValue = editor.state.doc.toString();
    if (currentValue === value) {
      return;
    }

    editor.dispatch({
      changes: {
        from: 0,
        to: currentValue.length,
        insert: value,
      },
    });
  }
);

watch(
  () => props.filePath,
  () => {
    reconfigure(languageCompartment, buildLanguageSupport(props.filePath));
  }
);

watch(
  () => props.disabled,
  (disabled) => {
    reconfigure(readOnlyCompartment, EditorState.readOnly.of(disabled));
    reconfigure(editableCompartment, EditorView.editable.of(!disabled));
  }
);

watch(
  () => props.placeholder,
  (placeholder) => {
    reconfigure(placeholderCompartment, placeholder ? editorPlaceholder(placeholder) : []);
  }
);

onMounted(() => {
  createEditor();

  if (typeof document !== 'undefined' && typeof MutationObserver !== 'undefined') {
    themeObserver = new MutationObserver(() => {
      syncTheme();
    });
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    });
  }
});

onUnmounted(() => {
  if (themeObserver) {
    themeObserver.disconnect();
    themeObserver = null;
  }
  editor?.destroy();
  editor = null;
});

defineExpose({
  getSelectedText: () => {
    if (!editor) {
      return '';
    }
    return editor.state.sliceDoc(editor.state.selection.main.from, editor.state.selection.main.to);
  },
  focus: () => {
    editor?.focus();
  }
});
</script>

<style scoped>
.code-mirror-text-editor {
  height: 100%;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--layout-border-color);
  border-radius: 10px;
  background: var(--el-bg-color-overlay);
}

:deep(.cm-editor) {
  height: 100%;
  font-size: 13px;
}

:deep(.cm-focused) {
  outline: none;
}

:deep(.cm-scroller) {
  font-family: Menlo, Monaco, Consolas, monospace;
}

:deep(.cm-content),
:deep(.cm-gutter) {
  min-height: 100%;
}
</style>
