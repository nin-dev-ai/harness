import { Text } from "ink";
import { C, SPINNER, VENDOR } from "../theme.js";

export interface ActivityItem {
  id: string;
  vendor: string;
  what: string;
  now: string;
  time: string;
  focused: boolean;
}

/** What is happening right now: one calm line per working agent. */
export function Activity({ items, frame }: { items: ActivityItem[]; frame: number }) {
  return (
    <>
      {items.map((a) => {
        const v = VENDOR[a.vendor] ?? VENDOR.fake!;
        return (
          <Text key={a.id} wrap="truncate-end">
            {" "}
            <Text color={v.color}>{SPINNER[frame % SPINNER.length]} </Text>
            <Text bold={a.focused}>{a.id}</Text>
            <Text color={C.dim}>
              {" "}
              {a.what}
              {a.now ? ` · ${a.now}` : ""}
              {a.time ? ` · ${a.time}` : ""}
            </Text>
          </Text>
        );
      })}
    </>
  );
}
