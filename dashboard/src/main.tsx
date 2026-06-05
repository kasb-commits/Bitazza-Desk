import { StrictMode, Component } from 'react'
import type { ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'
import { ToastProvider } from './components/ui/Toast.tsx'

const API_BASE = (import.meta.env.VITE_API_URL as string | undefined) ?? '';

function sendClientLog(entry: Record<string, unknown>) {
  fetch(`${API_BASE}/api/logs/client`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'dashboard', entries: [entry] }),
  }).catch(() => {}); // fire-and-forget
}

class ErrorBoundary extends Component<{ children: ReactNode }, { error: string | null }> {
  state = { error: null };
  static getDerivedStateFromError(e: Error) { return { error: e.message }; }
  componentDidCatch(error: Error, info: { componentStack: string }) {
    sendClientLog({
      level: 'error',
      event: 'react_error_boundary',
      message: error.message,
      stack: error.stack,
      component: info.componentStack,
      url: window.location.href,
    });
  }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 40, fontFamily: 'sans-serif' }}>
        <h2 style={{ color: 'red' }}>Dashboard crashed</h2>
        <pre style={{ background: '#fee', padding: 16, borderRadius: 8 }}>{this.state.error}</pre>
        <button onClick={() => this.setState({ error: null })}>Retry</button>
      </div>
    );
    return this.props.children;
  }
}

window.addEventListener('unhandledrejection', (e) => {
  sendClientLog({
    level: 'error',
    event: 'unhandled_rejection',
    message: e.reason instanceof Error ? e.reason.message : String(e.reason),
    stack: e.reason instanceof Error ? e.reason.stack : undefined,
    url: window.location.href,
  });
});

window.addEventListener('error', (e) => {
  sendClientLog({
    level: 'error',
    event: 'window_error',
    message: e.message,
    stack: e.error instanceof Error ? e.error.stack : undefined,
    url: window.location.href,
  });
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <BrowserRouter>
        <ToastProvider>
          <App />
        </ToastProvider>
      </BrowserRouter>
    </ErrorBoundary>
  </StrictMode>,
)
