import { subjectDirectory, type Subject } from '@st-vault/api-schema';
import type { ImagePriority } from '../../shared/lib/image-loader';
import { tr } from '../../shared/lib/i18n';
import { CoverImage } from './CoverImage';

const archiveLabels = {
  region_restricted: '地区限制',
  account_disabled: '账号已禁用',
  account_deleted: '账号已删除',
  unfollowed: '已取消关注',
} satisfies Record<NonNullable<Subject['archiveReason']>, string>;

export function SubjectPreview({
  subject,
  coverRevision,
  priority,
  selected,
  onChoose,
}: {
  subject: Subject;
  coverRevision: number;
  priority: ImagePriority;
  selected: boolean;
  onChoose: (subject: Subject) => void;
}): JSX.Element {
  const { group } = subjectDirectory(subject);
  const reason =
    group === 'ARCHIVED' || subject.archiveReason === 'region_restricted'
      ? subject.archiveReason
      : undefined;
  const statusLabel = reason ? tr(archiveLabels[reason]) : undefined;
  const description =
    statusLabel && reason !== 'unfollowed'
      ? tr('站点标记 · {{v0}}', { v0: statusLabel })
      : statusLabel;
  return (
    <button
      className="subject-preview"
      onClick={(event) => {
        if (event.detail === 0) onChoose(subject);
      }}
      aria-label={subject.handle}
      aria-description={description}
      aria-current={selected ? 'true' : undefined}
      title={[subject.handle, subject.id, description].filter(Boolean).join(' · ')}
    >
      <CoverImage
        id={subject.id}
        revision={coverRevision}
        status={subject.providerStatus}
        priority={priority}
      >
        {statusLabel && (
          <span className="subject-preview-status" aria-hidden="true">
            {statusLabel}
          </span>
        )}
        <strong className="subject-name">{subject.handle}</strong>
      </CoverImage>
    </button>
  );
}
