/** Small session controls using the existing contextual popover. */
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { useNativeSessionPolicy } from '@/hooks/useNativeSessionPolicy';

export function NativeCompactControls({ state }: { state: ReturnType<typeof useNativeSessionPolicy> }) {
  const { t } = useTranslation();
  if (!state.valid) return null;
  const percent = state.policy?.configured_percent;
  const pending = state.policy?.observation.active
    && state.policy.observation.applied_percent !== percent;
  const effort = state.policy?.configured_effort;
  const effortPending = state.policy?.observation.active
    && state.policy.observation.applied_effort !== effort;
  return (
    <div className="space-y-2 border-t pt-2 text-xs">
      <div className="font-medium">{t('nativeCompact.title', '本会话自动压缩')}</div>
      <div className="flex gap-2">
        <Button size="sm" variant={percent == null ? 'secondary' : 'outline'} disabled={state.saving}
          onClick={() => void state.save(null)}>{t('nativeCompact.inherit', '跟随Claude设置')}</Button>
        <Button size="sm" variant={percent === 60 ? 'secondary' : 'outline'} disabled={state.saving}
          onClick={() => void state.save(60)}>60%</Button>
      </div>
      <div className="text-muted-foreground">
        {pending ? t('nativeCompact.pending', '已保存，下一次工作开始时采用')
          : t('nativeCompact.checkpoint', '由Claude在模型请求前检查，工作会话保持不变')}
      </div>
      <div className="text-muted-foreground">
        {t('nativeCompact.observed', '本次运行已观察到压缩')}: {state.policy?.observation.compaction_count || 0}
      </div>
      <div className="text-muted-foreground">
        {t('nativeCompact.effort', '本会话思考强度')}: {effort || t('nativeCompact.inherit', '跟随Claude设置')}
        {effortPending && <div>{t('nativeCompact.pending', '已保存，下一次工作开始时采用')}</div>}
      </div>
      <div className="text-muted-foreground">
        {t('nativeCompact.effortRequestHint', '这里显示请求的强度；实际采用哪一档由 Claude 版本、模型和已有上限决定。')}
      </div>
      {state.error && <div role="alert" className="text-destructive break-words">{state.error}</div>}
    </div>
  );
}
