import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db, enforceRateLimit, required } from "../context.js";

export async function reportRoutes(app: FastifyInstance): Promise<void> {
  // Manual-review entry point of the chat moderation pipeline: the word
  // list rejects content synchronously; reports queue borderline content
  // and behavior for moderator review.
  app.post("/reports", async (req, reply) => {
    const u = await required(req, reply);
    if (!u) return;
    if (!(await enforceRateLimit(req, reply, "report", u.id, 10, 3_600_000)))
      return;

    const b = z
      .object({
        reason: z.string().trim().min(1).max(500),
        chatMessageId: z.string().uuid().optional(),
        roomCode: z.string().trim().toUpperCase().length(6).optional(),
      })
      .parse(req.body);

    let targetUserId: string | null = null;
    let roomCode = b.roomCode ?? null;

    if (b.chatMessageId) {
      const message = await db.query<{
        user_id: string;
        code: string | null;
      }>(
        `select cm.user_id, r.code
         from chat_messages cm
         join rooms r on r.id = cm.room_id
         where cm.id = $1`,
        [b.chatMessageId],
      );
      if (!message.rows[0]) {
        reply.code(404);
        return { error: "message_not_found" };
      }
      targetUserId = message.rows[0].user_id;
      roomCode = roomCode ?? message.rows[0].code;
    }

    const inserted = await db.query<{ id: string }>(
      `insert into reports(reporter_user_id, target_user_id, chat_message_id, room_code, reason)
       values ($1,$2,$3,$4,$5)
       returning id`,
      [u.id, targetUserId, b.chatMessageId ?? null, roomCode, b.reason],
    );

    reply.code(201);
    return { report: { id: inserted.rows[0].id } };
  });
}
