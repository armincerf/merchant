import { ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';
import clsx from 'clsx';

type SlideOverProps = {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  width?: 'sm' | 'md' | 'lg' | 'xl';
};

const widths = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
  xl: 'max-w-xl',
};

export function SlideOver({ open, onClose, title, children, width = 'md' }: SlideOverProps) {
  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    if (open) {
      document.addEventListener('keydown', handleEsc);
      document.body.style.overflow = 'hidden';
    }
    return () => {
      document.removeEventListener('keydown', handleEsc);
      document.body.style.overflow = '';
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 transition-opacity" onClick={onClose} />

      {/* Panel */}
      <div className="absolute inset-y-0 right-0 flex max-w-full">
        <div
          className={clsx(
            'w-screen transform transition-transform duration-300',
            widths[width],
            open ? 'translate-x-0' : 'translate-x-full'
          )}
        >
          <div
            className="flex h-full flex-col overflow-y-auto shadow-xl"
            style={{ background: 'var(--bg-content)' }}
          >
            {/* Header */}
            <div
              className="flex items-center justify-between px-6 py-4 border-b"
              style={{ borderColor: 'var(--border)' }}
            >
              <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>
                {title}
              </h2>
              <button
                onClick={onClose}
                className="p-1 rounded hover:bg-[var(--bg-hover)] transition-colors"
                style={{ color: 'var(--text-muted)' }}
              >
                <X size={20} />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 px-6 py-4">{children}</div>
          </div>
        </div>
      </div>
    </div>
  );
}



