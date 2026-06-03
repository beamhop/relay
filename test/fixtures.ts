/**
 * Shared test fixtures: a fixed keypair, pre-signed events covering each
 * storage class and content edge cases, and the official BIP-340 test vectors.
 *
 * Events were generated once with a BIP-340 signer over the project's own
 * secp256k1 module (private key = 3) and baked in as constants; the relay
 * itself only verifies signatures, never signs.
 */
import type { NostrEvent } from "../src/types.ts";

export const PRIV = "0000000000000000000000000000000000000000000000000000000000000003";
export const PUBKEY = "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9";

export const events = {
  note: {
    id: "76693f49d82d740eeae78a7740bac44e3481837331d369fcbcaad75730985f23",
    pubkey: PUBKEY,
    created_at: 1700000000,
    kind: 1,
    tags: [["t", "intro"]],
    content: "hello nostr",
    sig: "0946c7dd1f4c993ccddc1122165e1bc5ae79148ba0b408edf8b0e745d85e6441df448f74d4ff68dd7c7ad1ff3b839cea50aa952be4c83dcc3f25f8b2961b61dd",
  },
  noteUnicode: {
    id: "4182932fe1984fbd5e66bd4220ebc062fa53c276e13d5b1d7738edd25289004f",
    pubkey: PUBKEY,
    created_at: 1700000001,
    kind: 1,
    tags: [],
    content: 'line1\nline2 "quoted" \\back 🚀 ',
    sig: "dd18490f0726b560b0ba642c7a88440d86689e3a21704c10226f3cd36f01c8fed86c8689e7ba9b2850bc0443465523daec3d861624c56d2da4eada6793f6a8b6",
  },
  metadata: {
    id: "9293a1fda1deb45f43940bf883518c472c48e4c5a548ca893812aa4b1d076fa5",
    pubkey: PUBKEY,
    created_at: 1700000002,
    kind: 0,
    tags: [],
    content: '{"name":"alice"}',
    sig: "932c6a6cff397d2548d31cc597fef1f2cc01612f0ba082336f1a1209df1df4defe154f7200a97bacbc7d92e5aad78913297981983bab2c142e5b8e7865ccd3d4",
  },
  metadataNewer: {
    id: "ca6b90e5c128e008cfa10aa7e9015221cf44fadc9b55efdea03afa1eb938d77b",
    pubkey: PUBKEY,
    created_at: 1700000100,
    kind: 0,
    tags: [],
    content: '{"name":"alice2"}',
    sig: "6b474b901f885a96c5599710fe89fb77ca0ce7a75e446717e427f232618a45e83a39fa3699dcaa5fc8d374619eff9a5750133f4dbbe9558f8a32758f5a0428cd",
  },
  contacts: {
    id: "adfcfb33b8985e706a2b6af2a2164bea8d63516ed4884045277b9726fa71216e",
    pubkey: PUBKEY,
    created_at: 1700000003,
    kind: 3,
    tags: [["p", "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]],
    content: "",
    sig: "c7e4a7dbf55e696382329744abbe2a8e078ea413939d3c8b61d83e83766f8b26263759b0ad016c6704705be71247931ee728d704ab0a0fd6abd24e17683a1e40",
  },
  reaction: {
    id: "8dbff541914ad4fedf1d69f100af54e2262710a4e305b8df1a7dffaff5a46d85",
    pubkey: PUBKEY,
    created_at: 1700000004,
    kind: 7,
    tags: [
      ["e", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"],
      ["p", "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"],
    ],
    content: "+",
    sig: "7553900316fc9c9dda4949001420cfd0e4a321582af30e6869d00f336d24b2c411781730fa4b33ba9c6952ca23677edac9ba784c64ded322166514122c59ca68",
  },
  addressable: {
    id: "750c78ae8b6a4b5bba7f66e630a7ca9d173f4f7297a78a499fd42c6fc2f49712",
    pubkey: PUBKEY,
    created_at: 1700000005,
    kind: 30000,
    tags: [["d", "slot"]],
    content: "addr1",
    sig: "1ff7738b42049fb7368058fe491bb3bebf51db65c6176993831110efcc69833116244a3bbb9142a729671724d8d23a7f0465311b77b518f230a9e28a36afc12e",
  },
  addressableNewer: {
    id: "3c1c23f5623e6d8e30e63480ec24e7ced7e5a4080363f394ea7514d4e4bb0501",
    pubkey: PUBKEY,
    created_at: 1700000200,
    kind: 30000,
    tags: [["d", "slot"]],
    content: "addr2",
    sig: "b8837856b0aa31ba358860dab1fe3be34f9a0e0a78dc8c1d1364e64d8c03d485720bf3148398fd1fa0abfbac0d759b9ed990ac01ebedcb4b8daeaa1e1b6a1afb",
  },
  addressableOtherD: {
    id: "d9b890b707f0916956d9cb27d8a4b0372995f3a7a02784ff2b7784c91be1f9ac",
    pubkey: PUBKEY,
    created_at: 1700000006,
    kind: 30000,
    tags: [["d", "other"]],
    content: "addrB",
    sig: "5db97984c9d5e9229eae21b528b5ee86a2f4fc8fca9be481565a494a4375e1b4753be3335885bececedbc29662fe3297208a3316d90bae8b979109f76c05fac8",
  },
  ephemeral: {
    id: "76694e3e7cb23f63d7950821ad42e5260761bb1071215a1f3ecfa1f532fc4d98",
    pubkey: PUBKEY,
    created_at: 1700000007,
    kind: 20000,
    tags: [],
    content: "ephemeral",
    sig: "547b553c31db7b512127fb7b6513b813307d6c7901f2fa8e972bc9ea895fa7eadb72312287bd89606297ae9ed091a4b020816bdec45a32a609d5787d4fdf4e3b",
  },
} satisfies Record<string, NostrEvent>;

/** A deep copy of a fixture event, so tests can mutate freely. */
export function clone<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Official BIP-340 test vectors (subset covering the verification branches).
 * Fields are hex. `result` is the expected verify() outcome.
 * Source: bips/bip-0340/test-vectors.csv
 */
export interface SchnorrVector {
  index: number;
  pubkey: string;
  msg: string;
  sig: string;
  result: boolean;
  comment: string;
}

export const schnorrVectors: SchnorrVector[] = [
  {
    index: 0,
    pubkey: "F9308A019258C31049344F85F89D5229B531C845836F99B08601F113BCE036F9",
    msg: "0000000000000000000000000000000000000000000000000000000000000000",
    sig: "E907831F80848D1069A5371B402410364BDF1C5F8307B0084C55F1CE2DCA821525F66A4A85EA8B71E482A74F382D2CE5EBEEE8FDB2172F477DF4900D310536C0",
    result: true,
    comment: "valid",
  },
  {
    index: 1,
    pubkey: "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
    msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
    sig: "6896BD60EEAE296DB48A229FF71DFE071BDE413E6D43F917DC8DCF8C78DE33418906D11AC976ABCCB20B091292BFF4EA897EFCB639EA871CFA95F6DE339E4B0A",
    result: true,
    comment: "valid",
  },
  {
    index: 2,
    pubkey: "DD308AFEC5777E13121FA72B9CC1B7CC0139715309B086C960E18FD969774EB8",
    msg: "7E2D58D8B3BCDF1ABADEC7829054F90DDA9805AAB56C77333024B9D0A508B75C",
    sig: "5831AAEED7B44BB74E5EAB94BA9D4294C49BCF2A60728D8B4C200F50DD313C1BAB745879A5AD954A72C45A91C3A51D3C7ADEA98D82F8481E0E1E03674A6F3FB7",
    result: true,
    comment: "valid",
  },
  {
    index: 4,
    pubkey: "D69C3509BB99E412E68B0FE8544E72837DFA30746D8BE2AA65975F29D22DC7B9",
    msg: "4DF3C3F68FCC83B27E9D42C90431A72499F17875C81A599B566C9889B9696703",
    sig: "00000000000000000000003B78CE563F89A0ED9414F5AA28AD0D96D6795F9C6376AFB1548AF603B3EB45C9F8207DEE1060CB71C04E80F593060B07D28308D7F4",
    result: true,
    comment: "valid, large s",
  },
  {
    index: 5,
    pubkey: "EEFDEA4CDB677750A420FEE807EACF21EB9898AE79B9768766E4FAA04A2D4A34",
    msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
    sig: "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B",
    result: false,
    comment: "public key not on curve",
  },
  {
    index: 6,
    pubkey: "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
    msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
    sig: "FFF97BD5755EEEA420453A14355235D382F6472F8568A18B2F057A14602975563CC27944640AC607CD107AE10923D9EF7A73C643E166BE5EBEAFA34B1AC553E2",
    result: false,
    comment: "has_even_y(R) is false",
  },
  {
    index: 8,
    pubkey: "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
    msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
    sig: "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E177769961764B3AA9B2FFCB6EF947B6887A226E8D7C93E00C5ED0C1834FF0D0C2E6DA6",
    result: false,
    comment: "negated message",
  },
  {
    index: 10,
    pubkey: "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
    msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
    sig: "0000000000000000000000000000000000000000000000000000000000000000123DDA8328AF9C23A94C1FEECFD123BA4FB73476F0D594DCB65C6425BD186051",
    result: false,
    comment: "sG - eP is infinite (r=0)",
  },
  {
    index: 13,
    pubkey: "DFF1D77F2A671C5F36183726DB2341BE58FEAE1DA2DECED843240F7B502BA659",
    msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
    sig: "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E177769FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
    result: false,
    comment: "sig[32:64] is equal to curve order n",
  },
  {
    index: 14,
    pubkey: "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC30",
    msg: "243F6A8885A308D313198A2E03707344A4093822299F31D0082EFA98EC4E6C89",
    sig: "6CFF5C3BA86C69EA4B7376F31A9BCB4F74C1976089B2D9963DA2E5543E17776969E89B4C5564D00349106B8497785DD7D1D713A8AE82B32FA79D5F7FC407D39B",
    result: false,
    comment: "public key is not a valid X coordinate (>= p)",
  },
];
