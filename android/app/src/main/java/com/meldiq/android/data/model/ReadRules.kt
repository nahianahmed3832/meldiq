package com.meldiq.android.data.model

/** Read state (as Meldiq Web's `sync/rules.ts`): who hears that a conversation was read, and when a read clears it. */
object ReadRules {
    /** Read receipts go to other members only in DMs and small groups where this person can post. */
    const val RECEIPT_MAX_MEMBERS = 20

    fun sendsReceipts(type: String, memberCount: Int, canPost: Boolean): Boolean =
        type != "CHANNEL" && memberCount <= RECEIPT_MAX_MEMBERS && canPost

    /**
     * Another of this person's devices read up to [upTo]: the conversation is cleared here only if nothing newer arrived
     * since ([latestIncoming] is the newest message from someone else, by server time; null when there's none).
     */
    fun clearsHere(upTo: Long, latestIncoming: Long?): Boolean = latestIncoming == null || latestIncoming <= upTo
}
