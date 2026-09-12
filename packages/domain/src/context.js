/** Context normalization is independent of platform, storage and model SDKs. */
function record(value, allowed) {
    if (!value || typeof value !== 'object' || Array.isArray(value))
        throw new Error('INVALID_CONTEXT');
    const result = value;
    if (Object.keys(result).some((key) => !allowed.includes(key)))
        throw new Error('INVALID_CONTEXT');
    return result;
}
function opaqueId(value) {
    // IDs are opaque: trimming, case folding or Unicode normalization could merge distinct subjects.
    if (typeof value !== 'string' ||
        !value.length ||
        value.length > 256 ||
        value.trim() !== value ||
        /[\u0000-\u001f\u007f]/u.test(value))
        throw new Error('INVALID_CONTEXT_ID');
    return value;
}
/** Cross-source mappings require a separate explicit user decision; names never establish identity. */
export function normalizeIdentity(input) {
    const value = record(input, [
        'sourceInstanceId',
        'namespace',
        'subjectId',
        'projectId',
        'displayName',
        'key',
    ]);
    const sourceInstanceId = opaqueId(value.sourceInstanceId);
    const namespace = opaqueId(value.namespace);
    const subjectId = opaqueId(value.subjectId);
    const projectId = opaqueId(value.projectId);
    if (value.displayName !== undefined &&
        (typeof value.displayName !== 'string' || value.displayName.length > 512))
        throw new Error('INVALID_DISPLAY_NAME');
    const key = JSON.stringify([
        1,
        sourceInstanceId,
        namespace,
        subjectId,
        projectId,
    ]);
    if (value.key !== undefined && value.key !== key)
        throw new Error('INVALID_CONTEXT_ID');
    return {
        sourceInstanceId,
        namespace,
        subjectId,
        projectId,
        ...(value.displayName === undefined
            ? {}
            : { displayName: value.displayName }),
        key,
    };
}
/** Explicit offsets only. Never guess a timezone or silently roll invalid calendar dates forward. */
export function parseContextTimestamp(input) {
    if (typeof input !== 'string')
        throw new Error('INVALID_CONTEXT_TIME');
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(input);
    if (!match)
        throw new Error('INVALID_CONTEXT_TIME');
    const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
    const hour = Number(match[4]), minute = Number(match[5]), second = Number(match[6]);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    const offset = match[8];
    const offsetHours = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
    const offsetRemainder = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
    if (year < 1 ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > days[month - 1] ||
        hour > 23 ||
        minute > 59 ||
        second > 59 ||
        offsetHours > 14 ||
        offsetRemainder > 59 ||
        (offsetHours === 14 && offsetRemainder !== 0) ||
        offset === '-00:00')
        throw new Error('INVALID_CONTEXT_TIME');
    const offsetMinutes = (offset.startsWith('-') ? -1 : 1) * (offsetHours * 60 + offsetRemainder);
    const epochSeconds = Date.parse(`${input.slice(0, 19)}${offset}`) / 1000;
    if (!Number.isFinite(epochSeconds))
        throw new Error('INVALID_CONTEXT_TIME');
    const nanosecond = Number((match[7] ?? '').padEnd(9, '0'));
    const base = new Date(epochSeconds * 1000).toISOString();
    // Keep the normalized representation in the same bounded four-digit-year calendar.
    if (base.length !== 24 || base.startsWith('0000'))
        throw new Error('INVALID_CONTEXT_TIME');
    return {
        original: input,
        utc: `${base.slice(0, 19)}.${String(nanosecond).padStart(9, '0')}Z`,
        offsetMinutes,
        epochSeconds,
        nanosecond,
    };
}
/** The named source zone, when supplied, must agree with the offset at the occurrence instant. */
export function normalizeEventTime(input) {
    const value = record(input, ['occurredAt', 'receivedAt', 'sourceTimeZone']);
    const occurred = parseContextTimestamp(value.occurredAt);
    const received = parseContextTimestamp(value.receivedAt);
    let sourceTimeZone = null;
    if (value.sourceTimeZone !== undefined) {
        sourceTimeZone = opaqueId(value.sourceTimeZone);
        try {
            const formatter = new Intl.DateTimeFormat('en-US', {
                timeZone: sourceTimeZone,
                timeZoneName: 'longOffset',
            });
            const name = formatter
                .formatToParts(new Date(occurred.epochSeconds * 1000))
                .find((part) => part.type === 'timeZoneName')?.value;
            const offset = name === 'GMT'
                ? 0
                : (() => {
                    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? '');
                    if (!match)
                        throw new Error('INVALID_SOURCE_TIME_ZONE');
                    return ((match[1] === '-' ? -1 : 1) *
                        (Number(match[2]) * 60 + Number(match[3])));
                })();
            if (offset !== occurred.offsetMinutes)
                throw new Error('SOURCE_TIME_ZONE_MISMATCH');
        }
        catch {
            throw new Error('INVALID_SOURCE_TIME_ZONE');
        }
    }
    return {
        occurred,
        received,
        sourceTimeZone,
        parsingBasis: sourceTimeZone === null ? 'explicit_offset' : 'explicit_offset_and_zone',
    };
}
function normalizePlanUpdate(input) {
    const value = record(input, [
        'identity',
        'eventId',
        'revision',
        'time',
        'planFingerprint',
    ]);
    return {
        identity: normalizeIdentity(value.identity),
        eventId: opaqueId(value.eventId),
        revision: value.revision === null ? null : opaqueId(value.revision),
        time: normalizeEventTime(value.time),
        planFingerprint: opaqueId(value.planFingerprint),
    };
}
/** A decision only; callers still enforce manual locks, authorization and task version checks. */
export function comparePlanUpdates(currentInput, incomingInput) {
    const current = normalizePlanUpdate(currentInput), incoming = normalizePlanUpdate(incomingInput);
    if (current.identity.key !== incoming.identity.key)
        return { action: 'confirm', reason: 'different_scope' };
    const delta = incoming.time.occurred.epochSeconds - current.time.occurred.epochSeconds ||
        incoming.time.occurred.nanosecond - current.time.occurred.nanosecond;
    const equivalent = current.planFingerprint === incoming.planFingerprint;
    if (current.eventId === incoming.eventId) {
        // Revision IDs are opaque; neither lexical order nor arrival order establishes which edit is newer.
        if (current.revision === null ||
            incoming.revision === null ||
            current.revision !== incoming.revision)
            return { action: 'confirm', reason: 'unknown_revision_order' };
        return delta === 0 && equivalent
            ? { action: 'duplicate', reason: 'same_revision' }
            : { action: 'confirm', reason: 'revision_conflict' };
    }
    if (delta < 0)
        return { action: 'keep', reason: 'late_occurrence' };
    if (delta === 0)
        return equivalent
            ? { action: 'keep', reason: 'equivalent_plan' }
            : { action: 'confirm', reason: 'simultaneous_conflict' };
    return { action: 'replace', reason: 'newer_occurrence' };
}
