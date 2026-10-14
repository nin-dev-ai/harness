import { useEffect, useState } from "react";
import { Text, useInput } from "ink";

/**
 * Minimal single-line input. It owns its text (functional updates, so fast
 * typing never drops keys); a form starts empty each time it is opened.
 */
export function TextInput({ onSubmit, onCancel, onChange, placeholder }: { onSubmit(v: string): void; onCancel(): void; onChange?(v: string): void; placeholder?: string }) {
  const [value, setValue] = useState("");
  useEffect(() => onChange?.(value), [value, onChange]);
  useInput((input, key) => {
    if (key.return) return setValue((v) => (onSubmit(v), v));
    if (key.escape) return onCancel();
    if (key.backspace || key.delete) return setValue((v) => v.slice(0, -1));
    if (key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.ctrl || key.meta) return;
    if (input) setValue((v) => v + input);
  });
  return <Text>{value ? value : <Text color="gray">{placeholder ?? ""}</Text>}█</Text>;
}
