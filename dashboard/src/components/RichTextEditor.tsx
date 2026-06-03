import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

interface RichTextEditorProps {
  content: string;
  onChange: (html: string) => void;
  placeholder?: string;
  minHeight?: number;
  disabled?: boolean;
  onEnterSubmit?: () => void;
}

function ToolbarButton({
  active,
  onClick,
  title,
  children,
}: {
  active?: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault();
        onClick();
      }}
      title={title}
      className={`px-2 py-1 rounded text-sm transition-colors ${
        active
          ? 'bg-indigo-100 text-indigo-700 font-semibold'
          : 'text-gray-600 hover:bg-gray-100'
      }`}
    >
      {children}
    </button>
  );
}

// ─── Link modal ───────────────────────────────────────────────────────────────

interface LinkModalProps {
  initialUrl: string;
  hasExisting: boolean;
  onApply: (url: string) => void;
  onRemove: () => void;
  onClose: () => void;
}

function LinkModal({ initialUrl, hasExisting, onApply, onRemove, onClose }: LinkModalProps) {
  const [url, setUrl] = useState(initialUrl);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Small delay so the editor blur fires before we focus the input
    const t = setTimeout(() => inputRef.current?.select(), 50);
    return () => clearTimeout(t);
  }, []);

  const handleApply = () => {
    const trimmed = url.trim();
    if (!trimmed) { onRemove(); return; }
    // Prepend https:// if no protocol given
    const href = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    onApply(href);
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.35)', backdropFilter: 'blur(4px)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl flex flex-col overflow-hidden"
        style={{ width: 400, maxWidth: '90vw', border: '1px solid rgba(0,0,0,0.08)' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: '#ede9fe' }}>
              <svg className="w-4 h-4" style={{ color: '#6366f1' }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"/>
              </svg>
            </div>
            <span className="text-sm font-semibold text-gray-900">{hasExisting ? 'Edit link' : 'Insert link'}</span>
          </div>
          <button
            onMouseDown={onClose}
            className="w-7 h-7 rounded-lg flex items-center justify-center text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12"/>
            </svg>
          </button>
        </div>

        {/* Input */}
        <div className="px-5 pb-5">
          <label className="block text-xs font-medium text-gray-500 mb-1.5">URL</label>
          <input
            ref={inputRef}
            type="url"
            value={url}
            onChange={e => setUrl(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter') { e.preventDefault(); handleApply(); }
              if (e.key === 'Escape') onClose();
            }}
            placeholder="https://example.com"
            className="w-full text-sm px-3 py-2.5 rounded-lg border border-gray-200 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100 transition-colors placeholder:text-gray-300"
          />
        </div>

        {/* Footer */}
        <div className="flex items-center gap-2 px-5 py-4 border-t border-gray-100">
          {hasExisting && (
            <button
              onMouseDown={() => { onRemove(); }}
              className="flex items-center gap-1.5 text-xs font-medium px-3 py-2 rounded-lg text-red-500 hover:bg-red-50 transition-colors mr-auto"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
              </svg>
              Remove link
            </button>
          )}
          <button
            onMouseDown={onClose}
            className="text-xs font-medium px-4 py-2 rounded-lg border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors ml-auto"
          >
            Cancel
          </button>
          <button
            onMouseDown={handleApply}
            className="text-xs font-semibold px-4 py-2 rounded-lg text-white transition-colors"
            style={{ background: '#6366f1' }}
            onMouseEnter={e => (e.currentTarget.style.background = '#4f46e5')}
            onMouseLeave={e => (e.currentTarget.style.background = '#6366f1')}
          >
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ─── Editor ──────────────────────────────────────────────────────────────────

export default function RichTextEditor({
  content,
  onChange,
  placeholder = 'Type here…',
  minHeight = 80,
  disabled = false,
  onEnterSubmit,
}: RichTextEditorProps) {
  const [linkModal, setLinkModal] = useState<{ url: string; hasExisting: boolean } | null>(null);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
        codeBlock: false,
      }),
      Underline,
      Link.configure({
        openOnClick: false,
        autolink: true,
        HTMLAttributes: {
          rel: 'noopener noreferrer',
          target: '_blank',
        },
      }),
      Placeholder.configure({ placeholder }),
    ],
    content: content || '',
    editable: !disabled,
    onUpdate({ editor }) {
      const html = editor.isEmpty ? '' : editor.getHTML();
      onChange(html);
    },
    editorProps: {
      handleKeyDown(view, event) {
        if (event.key === 'Enter' && !event.shiftKey && onEnterSubmit) {
          event.preventDefault();
          onEnterSubmit();
          return true;
        }
        return false;
      },
      handlePaste(view, event) {
        const pastedText = event.clipboardData?.getData('text/plain')?.trim();
        if (!pastedText) return false;

        // Only intercept if pasted content looks like a URL
        if (!/^https?:\/\/\S+/.test(pastedText)) return false;

        // Only intercept when there's a non-empty text selection
        const { from, to } = view.state.selection;
        if (from === to) return false;

        // Apply the URL as a link mark over the selected text
        event.preventDefault();
        const linkMark = view.state.schema.marks.link;
        if (!linkMark) return false;
        view.dispatch(
          view.state.tr.addMark(
            from,
            to,
            linkMark.create({ href: pastedText, target: '_blank', rel: 'noopener noreferrer' }),
          ),
        );
        return true;
      },
    },
  });

  // Sync external content changes (e.g. when a canned response is inserted)
  useEffect(() => {
    if (!editor) return;
    const current = editor.isEmpty ? '' : editor.getHTML();
    if (content !== current) {
      editor.commands.setContent(content || '', false);
    }
  }, [content, editor]);

  useEffect(() => {
    if (editor) editor.setEditable(!disabled);
  }, [disabled, editor]);

  const openLinkModal = useCallback(() => {
    if (!editor) return;
    const existing = editor.getAttributes('link').href as string | undefined;
    setLinkModal({ url: existing ?? '', hasExisting: !!existing });
  }, [editor]);

  const applyLink = useCallback((url: string) => {
    if (!editor) return;
    editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    setLinkModal(null);
  }, [editor]);

  const removeLink = useCallback(() => {
    if (!editor) return;
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    setLinkModal(null);
  }, [editor]);

  if (!editor) return null;

  return (
    <>
      <div
        className={`border rounded-lg overflow-hidden bg-white transition-colors ${
          disabled ? 'opacity-60 cursor-not-allowed' : 'focus-within:border-indigo-400'
        }`}
      >
        {/* Toolbar */}
        <div className="flex flex-wrap gap-0.5 px-2 py-1 border-b bg-gray-50">
          <ToolbarButton
            active={editor.isActive('bold')}
            onClick={() => editor.chain().focus().toggleBold().run()}
            title="Bold (Ctrl+B)"
          >
            <strong>B</strong>
          </ToolbarButton>

          <ToolbarButton
            active={editor.isActive('italic')}
            onClick={() => editor.chain().focus().toggleItalic().run()}
            title="Italic (Ctrl+I)"
          >
            <em>I</em>
          </ToolbarButton>

          <ToolbarButton
            active={editor.isActive('underline')}
            onClick={() => editor.chain().focus().toggleUnderline().run()}
            title="Underline (Ctrl+U)"
          >
            <span style={{ textDecoration: 'underline' }}>U</span>
          </ToolbarButton>

          <ToolbarButton
            active={editor.isActive('strike')}
            onClick={() => editor.chain().focus().toggleStrike().run()}
            title="Strikethrough"
          >
            <span style={{ textDecoration: 'line-through' }}>S</span>
          </ToolbarButton>

          <div className="w-px bg-gray-200 mx-1 self-stretch" />

          <ToolbarButton
            active={editor.isActive('heading', { level: 2 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
            title="Heading"
          >
            H2
          </ToolbarButton>

          <ToolbarButton
            active={editor.isActive('heading', { level: 3 })}
            onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
            title="Subheading"
          >
            H3
          </ToolbarButton>

          <div className="w-px bg-gray-200 mx-1 self-stretch" />

          <ToolbarButton
            active={editor.isActive('bulletList')}
            onClick={() => editor.chain().focus().toggleBulletList().run()}
            title="Bullet list"
          >
            • ≡
          </ToolbarButton>

          <ToolbarButton
            active={editor.isActive('orderedList')}
            onClick={() => editor.chain().focus().toggleOrderedList().run()}
            title="Ordered list"
          >
            1. ≡
          </ToolbarButton>

          <div className="w-px bg-gray-200 mx-1 self-stretch" />

          <ToolbarButton
            active={editor.isActive('link')}
            onClick={openLinkModal}
            title="Insert link"
          >
            🔗
          </ToolbarButton>

          <ToolbarButton
            onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}
            title="Clear formatting"
          >
            Tx
          </ToolbarButton>
        </div>

        {/* Editor area */}
        <EditorContent
          editor={editor}
          style={{ minHeight }}
          className="rich-editor-content px-3 py-2 text-sm text-gray-900 outline-none"
        />
      </div>

      {linkModal && (
        <LinkModal
          initialUrl={linkModal.url}
          hasExisting={linkModal.hasExisting}
          onApply={applyLink}
          onRemove={removeLink}
          onClose={() => setLinkModal(null)}
        />
      )}
    </>
  );
}
