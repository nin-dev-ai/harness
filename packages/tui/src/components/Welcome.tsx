import { Box, Text } from "ink";
import { C, VENDOR, type Theme } from "../theme.js";
import { GradientText } from "./Logo.js";

export interface WelcomeAgent {
  id: string;
  vendor: string;
  model: string;
  status: string;
  statusColor?: string | undefined;
  focused: boolean;
}

/** The welcome card: name, folder, and every agent with its tool and model. */
export function Welcome({ t, version, project, folder, branch, agents, width, maxAgents }: { t: Theme; version: string; project: string; folder: string; branch: string; agents: WelcomeAgent[]; width: number; maxAgents: number }) {
  const shown = agents.slice(0, maxAgents);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.gradient[0]} paddingX={1} width={Math.min(width, 76)}>
      <Text>
        <GradientText text="✦ harness" t={t} bold />
        <Text color={C.dim}> v{version} · </Text>
        <Text bold>{project}</Text>
      </Text>
      <Text color={C.dim} wrap="truncate-end">
        {folder} · ⎇ {branch}
      </Text>
      <Text> </Text>
      <Text color={C.dim}>{agents.length === 1 ? "your agent" : `your ${agents.length} agents`}</Text>
      {shown.map((a) => {
        const v = VENDOR[a.vendor] ?? VENDOR.fake!;
        return (
          <Text key={a.id} wrap="truncate-end">
            <Text color={a.focused ? t.accent : undefined}>{a.focused ? "▸" : " "}</Text>
            <Text color={v.color}> {v.icon} </Text>
            <Text bold={a.focused}>{a.id.padEnd(14)}</Text>
            <Text color={v.color}>{a.vendor.padEnd(8)}</Text>
            <Text color={C.dim}>{a.model.padEnd(14)}</Text>
            <Text color={a.statusColor} dimColor={!a.statusColor}>
              {a.status}
            </Text>
          </Text>
        );
      })}
      {agents.length > shown.length ? <Text color={C.dim}>  +{agents.length - shown.length} more (/agents)</Text> : null}
    </Box>
  );
}
