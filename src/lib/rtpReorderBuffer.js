/**
 * RTP Reorder Buffer - reorders RTP packets by sequence number
 *
 * RTP over UDP can deliver packets out of order. This buffer holds packets
 * briefly and emits them in sequence order to prevent H.264 FU-A reassembly
 * failures.
 *
 * @see docs/plans/2026-02-01-rtp-reorder-buffer-design.md
 */

const MAX_SEQ = 65536; // RTP sequence numbers are 16-bit (0-65535)
const HALF_SEQ = 32768; // Half the sequence space for wraparound detection

/**
 * Check if seqA comes before seqB, accounting for 16-bit wraparound
 * @param {number} seqA - First sequence number
 * @param {number} seqB - Second sequence number
 * @returns {boolean} - True if seqA is before seqB
 */
function seqBefore(seqA, seqB) {
    const diff = (seqB - seqA + MAX_SEQ) % MAX_SEQ;
    return diff > 0 && diff < HALF_SEQ;
}

/**
 * Calculate distance from seqA to seqB, accounting for wraparound
 * @param {number} seqA - First sequence number
 * @param {number} seqB - Second sequence number
 * @returns {number} - Distance (always positive, in forward direction)
 */
function seqDistance(seqA, seqB) {
    return (seqB - seqA + MAX_SEQ) % MAX_SEQ;
}

class RtpReorderBuffer {
    /**
     * @param {Object} options
     * @param {number} [options.maxBufferSize=30] - Max packets to hold
     * @param {number} [options.maxWaitMs=50] - Max time to wait for missing packet
     * @param {Function} options.onPacket - Callback for ordered packets (rtp) => void
     * @param {Function} [options.log] - Optional logger function
     */
    constructor(options) {
        this.maxBufferSize = options.maxBufferSize ?? 30;
        this.maxWaitMs = options.maxWaitMs ?? 50;
        this.onPacket = options.onPacket;
        this.log = options.log ?? null;

        // State
        this.expectedSeq = -1; // -1 = not initialized
        this.buffer = new Map(); // seq -> rtp packet
        this.lastEmitTime = Date.now();
        this.flushTimer = null;

        // Stats
        this.stats = {
            received: 0,
            emitted: 0,
            reordered: 0,
            dropped: 0
        };
    }

    /**
     * Push an RTP packet into the buffer
     * @param {Object} rtp - RTP packet with header.sequenceNumber and payload
     */
    push(rtp) {
        const seq = rtp.header.sequenceNumber;
        this.stats.received++;

        // First packet initializes expected sequence
        if (this.expectedSeq === -1) {
            this.expectedSeq = seq;
            if (this.log) {
                this.log(`[RtpReorder] Initialized at seq=${seq}`);
            }
        }

        // Check if packet is too old (already past expected)
        if (seqBefore(seq, this.expectedSeq)) {
            // Late packet we've already moved past - drop it
            this.stats.dropped++;
            return;
        }

        // Store packet in buffer
        this.buffer.set(seq, rtp);

        // Track if this packet arrived out of order
        if (seq !== this.expectedSeq && this.buffer.size > 1) {
            this.stats.reordered++;
        }

        // Try to emit in-order packets
        this._emitReady();

        // Handle buffer overflow
        if (this.buffer.size > this.maxBufferSize) {
            this._forceFlush();
        }

        // Set up timeout flush if we have buffered packets
        this._scheduleFlush();
    }

    /**
     * Emit all packets that are ready (in sequence)
     */
    _emitReady() {
        while (this.buffer.has(this.expectedSeq)) {
            const rtp = this.buffer.get(this.expectedSeq);
            this.buffer.delete(this.expectedSeq);

            this.onPacket(rtp);
            this.stats.emitted++;
            this.lastEmitTime = Date.now();

            // Advance to next expected sequence (with wraparound)
            this.expectedSeq = (this.expectedSeq + 1) % MAX_SEQ;
        }
    }

    /**
     * Force flush when buffer is full or timeout expires
     * Skips missing packets and emits what we have
     */
    _forceFlush() {
        if (this.buffer.size === 0) return;

        // Find the lowest sequence number in the buffer
        let minSeq = null;
        for (const seq of this.buffer.keys()) {
            if (minSeq === null || seqBefore(seq, minSeq)) {
                minSeq = seq;
            }
        }

        if (minSeq === null) return;

        // Calculate how many we're skipping
        const skipped = seqDistance(this.expectedSeq, minSeq);
        if (skipped > 0) {
            this.stats.dropped += skipped;
            if (this.log && skipped > 1) {
                this.log(`[RtpReorder] Skipping ${skipped} missing packets (${this.expectedSeq} -> ${minSeq})`);
            }
        }

        // Jump to the minimum sequence and emit from there
        this.expectedSeq = minSeq;
        this._emitReady();
    }

    /**
     * Schedule a flush after maxWaitMs if we have buffered packets
     */
    _scheduleFlush() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }

        if (this.buffer.size > 0 && this.maxWaitMs > 0) {
            this.flushTimer = setTimeout(() => {
                this.flushTimer = null;
                const waitedMs = Date.now() - this.lastEmitTime;
                if (waitedMs >= this.maxWaitMs && this.buffer.size > 0) {
                    this._forceFlush();
                }
            }, this.maxWaitMs);
        }
    }

    /**
     * Get current statistics
     * @returns {Object} Stats object
     */
    getStats() {
        return {
            ...this.stats,
            buffered: this.buffer.size,
            expectedSeq: this.expectedSeq
        };
    }

    /**
     * Get formatted stats string for logging
     * @returns {string}
     */
    getStatsString() {
        const s = this.getStats();
        return `recv=${s.received} emit=${s.emitted} reorder=${s.reordered} drop=${s.dropped} buf=${s.buffered}`;
    }

    /**
     * Flush all remaining packets and reset
     */
    flush() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this._forceFlush();
    }

    /**
     * Clean up timers
     */
    destroy() {
        if (this.flushTimer) {
            clearTimeout(this.flushTimer);
            this.flushTimer = null;
        }
        this.buffer.clear();
    }
}

export default RtpReorderBuffer;
