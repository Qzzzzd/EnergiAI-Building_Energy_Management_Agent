import {
  AlertCircle,
  Check,
  Circle,
  CircleOff,
  Clock3,
  LoaderCircle,
  Pause,
  TriangleAlert,
  X,
} from 'lucide-react';
import type { SessionStatus, TurnStatus } from '../domain';

type Status = SessionStatus | TurnStatus;

const labels: Record<Status, string> = {
  idle: '未开始',
  queued: '已排队',
  running: '运行中',
  needs_input: '等待回答',
  completed: '已完成',
  partial: '部分成功',
  failed: '失败',
  cancelling: '取消中',
  cancelled: '已取消',
  interrupted: '已中断',
  deleting: '删除中',
};

export function statusLabel(status: Status): string {
  return labels[status];
}

function StatusIcon({ status }: { status: Status }) {
  const props = { size: 13, strokeWidth: 2.2, 'aria-hidden': true } as const;
  switch (status) {
    case 'running':
    case 'queued':
    case 'cancelling':
      return <LoaderCircle {...props} className="spin" />;
    case 'needs_input':
      return <Pause {...props} />;
    case 'completed':
      return <Check {...props} />;
    case 'partial':
      return <TriangleAlert {...props} />;
    case 'failed':
      return <X {...props} />;
    case 'cancelled':
      return <CircleOff {...props} />;
    case 'interrupted':
      return <AlertCircle {...props} />;
    case 'deleting':
      return <Clock3 {...props} />;
    case 'idle':
      return <Circle {...props} />;
  }
}

export function StatusMark({ status, compact = false }: { status: Status; compact?: boolean }) {
  return (
    <span className={`status-mark status-${status}`} title={labels[status]}>
      <StatusIcon status={status} />
      {!compact && <span>{labels[status]}</span>}
    </span>
  );
}
