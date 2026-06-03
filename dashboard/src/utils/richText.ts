import DOMPurify from 'dompurify';

const ALLOWED_TAGS = ['p','strong','em','u','s','h2','h3','ul','ol','li','a','br','blockquote','code'];
const SANITIZE_CONFIG: DOMPurify.Config = {
  ALLOWED_TAGS,
  ALLOWED_ATTR: ['href', 'target', 'rel'],
};

export function isHtml(str: string): boolean {
  return /<[a-z][\s\S]*>/i.test(str);
}

export function safeHtml(content: string): string {
  return DOMPurify.sanitize(content, SANITIZE_CONFIG);
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, '');
}

/** Convert plain text to a simple HTML paragraph for TipTap. */
export function textToHtml(text: string): string {
  return '<p>' + text.replace(/\n\n/g, '</p><p>').replace(/\n/g, '<br>') + '</p>';
}
