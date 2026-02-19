import { getIpRangeCreditCap } from "$lib/config/runtime.js";
import { isUniqueConstraintError } from "$lib/db/errors.js";
import type { PrismaClient } from "$lib/generated/prisma/client";

function startOfUTCDay(date: Date): Date {
  const dayStart = new Date(date);
  dayStart.setUTCHours(0, 0, 0, 0);
  return dayStart;
}

export async function maybeIncrementUniqueViewScore(
  prisma: PrismaClient,
  postId: string,
  viewerKey: string,
  ipRangeKey: string,
): Promise<boolean> {
  const ipRangeCreditCap = getIpRangeCreditCap();
  const bucketDay = startOfUTCDay(new Date());

  return prisma.$transaction(async (tx) => {
    // Serialize per-post view-credit updates so cap checks stay consistent
    // under concurrent viewPost requests.
    await tx.$queryRaw`SELECT 1 FROM "Post" WHERE "id" = ${postId} FOR UPDATE`;

    const ipRangeCount = await tx.postViewCredit.count({
      where: { postId, ipRangeKey, bucketDay },
    });
    if (ipRangeCount >= ipRangeCreditCap) return false;

    try {
      await tx.postViewCredit.create({
        data: { postId, viewerKey, ipRangeKey, bucketDay },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) return false;
      throw error;
    }

    await tx.post.update({
      where: { id: postId },
      data: { uniqueViewScore: { increment: 1 } },
    });
    return true;
  });
}
