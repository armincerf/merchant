import clsx from 'clsx';

type Status =
  | 'pending'
  | 'paid'
  | 'processing'
  | 'shipped'
  | 'delivered'
  | 'refunded'
  | 'canceled'
  | 'active'
  | 'draft';

const statusStyles: Record<Status, string> = {
  pending: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-400',
  paid: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400',
  shipped: 'bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-400',
  delivered: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-400',
  refunded: 'bg-gray-100 text-gray-800 dark:bg-gray-800 dark:text-gray-400',
  canceled: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400',
  active: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400',
  draft: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
};

export function StatusBadge({ status }: { status: Status }) {
  return (
    <span
      className={clsx(
        'inline-flex items-center px-2 py-0.5 text-xs font-medium rounded-sm',
        statusStyles[status] || statusStyles.pending
      )}
    >
      {status}
    </span>
  );
}



