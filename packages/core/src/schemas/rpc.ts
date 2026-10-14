import { z } from "zod";

/**
 * Daemon RPC: newline-delimited JSON over a Unix socket.
 * Requests carry an id; responses echo it. Subscriptions push `event` notifications.
 * Method params and results are validated per method by the daemon (M7).
 */
export const RpcRequestSchema = z.object({
  id: z.number().int(),
  method: z.string(),
  params: z.unknown().optional(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  details: z.unknown().optional(),
});

export const RpcResponseSchema = z.union([
  z.object({ id: z.number().int(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.number().int(), ok: z.literal(false), error: RpcErrorSchema }),
]);
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

export const RpcNotificationSchema = z.object({
  notify: z.literal("event"),
  event: z.unknown(),
});
export type RpcNotification = z.infer<typeof RpcNotificationSchema>;

export const RpcMessageSchema = z.union([RpcResponseSchema, RpcNotificationSchema]);
