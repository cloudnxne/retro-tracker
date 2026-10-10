import { useEffect, useState } from 'react';
import { onWriteFailure, type WriteFailure } from '../lib/safeWrite';

/** "Couldn't save set 2: phone storage is full. TRY AGAIN". Stays until retried or saved. */
export function WriteErrorToast() {
  const [failure, setFailure] = useState<WriteFailure | null>(null);
  useEffect(() => onWriteFailure(setFailure), []);
  if (!failure) return null;
  return (
    <div className="toast error" role="alert">
      Couldn't save {failure.label.toLowerCase()}: {failure.message}.
      <button onClick={() => void failure.retry()}>TRY AGAIN</button>
    </div>
  );
}
