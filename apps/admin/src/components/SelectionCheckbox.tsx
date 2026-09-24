import { useEffect, useRef } from 'react';

export default function SelectionCheckbox({ checked, indeterminate = false, ...props }: {
  checked: boolean;
  indeterminate?: boolean;
  disabled?: boolean;
  onChange: () => void;
  'aria-label': string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return <input ref={ref} type="checkbox" checked={checked} {...props}
    className="h-4 w-4 cursor-pointer accent-sky-400 disabled:cursor-not-allowed" />;
}
