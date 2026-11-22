/** Rotate in directory order while allowing urgent work to take the next slot. */
export function captureRotation<T extends { id: string }>(
  subjects: readonly T[],
  cursor: number,
  urgent: ReadonlySet<string>,
  pending: (id: string) => boolean,
) {
  const start = subjects.length ? cursor % subjects.length : 0;
  const ordered = [...subjects.slice(start), ...subjects.slice(0, start)];
  const positions = new Map(subjects.map((subject, index) => [subject.id, index]));
  let index = 0;
  return {
    next(): { subject: T; cursor: number } | null {
      if (index >= ordered.length) return null;
      // Manual requests can arrive after the rotation started.
      if (urgent.size) {
        for (let position = index; position < ordered.length; position++) {
          const id = ordered[position].id;
          if (!urgent.has(id) || pending(id)) continue;
          [ordered[index], ordered[position]] = [ordered[position], ordered[index]];
          break;
        }
      }
      const subject = ordered[index++];
      return { subject, cursor: (positions.get(subject.id)! + 1) % subjects.length };
    },
  };
}
