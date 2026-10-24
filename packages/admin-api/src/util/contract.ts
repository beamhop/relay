/**
 * Compile-time ties between request schemas (zod) and the request types of @beamhop/sdk/admin-contract, so neither can
 * drift from the other: `true satisfies Same<z.output<typeof Schema>, ContractType>` fails to build unless both are
 * assignable to each other.
 */
export type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
/** `B` is accepted by a schema whose input type is `A` (for fields the schema only checks after parsing). */
export type Accepts<A, B> = [B] extends [A] ? true : false;
