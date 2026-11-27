import type { Subject } from '@st-vault/api-schema';
import { useState } from 'react';
import { useSyncClock } from '../../shared/lib/sync';
import { CoverImage } from '../directory/CoverImage';

export function PlaybackPosterImage({
  subject,
  revision,
}: {
  subject: Subject;
  revision: number;
}): JSX.Element {
  return (
    <CoverImage
      key={subject.id}
      id={subject.id}
      revision={revision}
      status={subject.providerStatus}
    />
  );
}

export function WorkbenchPosterImage({ subject }: { subject: Subject }): JSX.Element {
  const [revision, setRevision] = useState(0);
  useSyncClock(() => setRevision((previous) => previous + 1));
  return <PlaybackPosterImage subject={subject} revision={revision} />;
}
