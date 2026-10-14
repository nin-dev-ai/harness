import { Box, Text } from "ink";
import type { RouteView } from "@harness/daemon";
import { theme } from "../theme.js";
import { TextInput } from "./TextInput.js";

export const LIMIT_WINDOWS = ["5h", "7d", "budget"] as const;

export function LimitsEditor({ route, window, onSubmit, onCancel }: { route: RouteView; window: (typeof LIMIT_WINDOWS)[number]; onSubmit(v: string): void; onCancel(): void }) {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>
        LIMITS {route.route} ({route.vendor}, {route.auth})
      </Text>
      {route.windows.length === 0 && <Text color={theme.dim}>no usage data: set a manual budget</Text>}
      {route.windows.map((w) => (
        <Text key={w.kind}>
          {"  "}
          {w.kind.padEnd(7)} {w.display.padStart(7)} cap {w.capPct}% [{w.source}]
        </Text>
      ))}
      <Text>
        window:{" "}
        {LIMIT_WINDOWS.map((w) => (
          <Text key={w} inverse={w === window}>
            {" "}
            {w}{" "}
          </Text>
        ))}
      </Text>
      <Box>
        <Text>{window === "budget" ? "budget (e.g. 40 runs/day): " : "cap (e.g. 85%): "}</Text>
        <TextInput onSubmit={onSubmit} onCancel={onCancel} />
      </Box>
    </Box>
  );
}
