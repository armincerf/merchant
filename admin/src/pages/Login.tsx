import { useState } from 'react';
import { Loader2 } from 'lucide-react';

type LoginProps = {
  onLogin: (apiUrl: string, apiKey: string) => Promise<void>;
};

export function Login({ onLogin }: LoginProps) {
  const [apiUrl, setApiUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      await onLogin(apiUrl.replace(/\/$/, ''), apiKey);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Connection failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-4"
      style={{ background: 'var(--bg-app)' }}
    >
      <div
        className="w-full max-w-sm p-8 rounded shadow-sm"
        style={{ background: 'var(--bg-content)', border: '1px solid var(--border)' }}
      >
        {/* Logo */}
        <div className="text-center mb-6">
          <div className="inline-flex items-center justify-center mb-4">
            <svg
              className="w-10 h-10"
              viewBox="0 0 88 88"
              fill="currentColor"
              style={{ color: 'var(--text)' }}
            >
              <path d="M46 84V88H42V84H46ZM84 46V42C84 21.0132 66.9868 4 46 4H42C21.0132 4 4 21.0132 4 42V46C4 66.9868 21.0132 84 42 84V88C18.804 88 0 69.196 0 46V42C1.01484e-06 19.1665 18.221 0.588624 40.916 0.0136719L42 0H46L47.084 0.0136719C69.779 0.588625 88 19.1665 88 42V46L87.9863 47.084C87.4114 69.779 68.8335 88 46 88V84C66.9868 84 84 66.9868 84 46Z" />
              <path d="M55.6 29C60.4 29 63.6 32.2 63.6 37V61H57.2V40.2C57.2 37 55.6 35.4 52.4 35.4C49.2 35.4 47.6 37 47.6 40.2V61H41.2V35.4H31.6V61H25.2V29H47.6V37C47.6 32.2 50.8 29 55.6 29Z" />
            </svg>
          </div>
          <h1 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
            Connect to merchant
          </h1>
          <p className="text-sm mt-1" style={{ color: 'var(--text-secondary)' }}>
            Enter your API endpoint and admin key
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-3">
          <input
            type="url"
            value={apiUrl}
            onChange={(e) => setApiUrl(e.target.value)}
            placeholder="https://your-api.workers.dev"
            required
            className="w-full px-3 py-2.5 text-sm font-mono rounded-sm transition-colors focus:outline-none focus:ring-2"
            style={
              {
                background: 'var(--bg-content)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
                '--tw-ring-color': 'var(--accent)',
              } as React.CSSProperties
            }
          />
          <input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="sk_..."
            required
            className="w-full px-3 py-2.5 text-sm font-mono rounded-sm transition-colors focus:outline-none focus:ring-2"
            style={
              {
                background: 'var(--bg-content)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
                '--tw-ring-color': 'var(--accent)',
              } as React.CSSProperties
            }
          />

          {error && <p className="text-sm text-red-500">{error}</p>}

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 px-4 py-2.5 text-sm font-semibold rounded-sm transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
            style={{
              background: 'var(--accent)',
              color: 'var(--text-inverse)',
            }}
          >
            {loading && <Loader2 size={16} className="animate-spin" />}
            {loading ? 'Connecting...' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  );
}



