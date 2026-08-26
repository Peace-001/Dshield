import { NextRequest, NextResponse } from "next/server";
import * as StellarSdk from "@stellar/stellar-sdk";
import { checkRateLimit, clientKey } from "@/lib/rateLimit";

// Server-side relayer: submits a withdrawal on the user's behalf, paying the
// transaction fee from the relayer account. Because the pool contract binds the
// payout recipient into the proof (see recipient_hash_from_address), the relayer
// cannot redirect funds — it can only submit or refuse. This unlinks the
// withdrawer: the user's own account never appears on-chain.
const RELAYER_SECRET = process.env.RELAYER_SECRET || "";
const RPC_URL =
  process.env.NEXT_PUBLIC_RPC_URL || "http://localhost:8000/soroban/rpc";
const PASSPHRASE =
  process.env.NEXT_PUBLIC_NETWORK_PASSPHRASE ||
  "Standalone Network ; February 2017";

function isStrKeyContract(id: string): boolean {
  try {
    return StellarSdk.StrKey.isValidContract(id);
  } catch {
    return false;
  }
}

// Garbage proofs are cheap to submit but still cost a simulate/submit RPC
// round-trip against the relayer's own quota; cap how many a single client
// can fire without limiting legitimate rapid multi-note withdrawals too hard.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 5 * 60 * 1000; // 5 minutes

export async function POST(req: NextRequest) {
  if (!RELAYER_SECRET) {
    return NextResponse.json(
      { error: "Relayer is not configured (RELAYER_SECRET unset).", code: "no_relayer" },
      { status: 503 },
    );
  }

  const rl = await checkRateLimit(`relay:${clientKey(req.headers)}`, RATE_LIMIT, RATE_WINDOW_MS);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many relay requests. Try again later.", code: "rate_limited" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  let poolId: string;
  let recipient: string;
  let publicInputs: string;
  let proof: string;
  try {
    const body = await req.json();
    poolId = String(body.poolId || "");
    recipient = String(body.recipient || "");
    publicInputs = String(body.publicInputs || "");
    proof = String(body.proof || "");
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!isStrKeyContract(poolId)) {
    return NextResponse.json({ error: "Invalid pool id." }, { status: 400 });
  }
  if (!StellarSdk.StrKey.isValidEd25519PublicKey(recipient)) {
    return NextResponse.json({ error: "Invalid recipient address." }, { status: 400 });
  }
  if (!/^[0-9a-fA-F]+$/.test(publicInputs) || !/^[0-9a-fA-F]+$/.test(proof)) {
    return NextResponse.json(
      { error: "publicInputs and proof must be hex strings." },
      { status: 400 },
    );
  }

  try {
    const server = new StellarSdk.rpc.Server(RPC_URL, {
      allowHttp: RPC_URL.startsWith("http://"),
    });
    const relayer = StellarSdk.Keypair.fromSecret(RELAYER_SECRET);
    const source = await server.getAccount(relayer.publicKey());
    const contract = new StellarSdk.Contract(poolId);

    const tx = new StellarSdk.TransactionBuilder(source, {
      fee: StellarSdk.BASE_FEE,
      networkPassphrase: PASSPHRASE,
    })
      .addOperation(
        contract.call(
          "withdraw",
          StellarSdk.nativeToScVal(recipient, { type: "address" }),
          StellarSdk.xdr.ScVal.scvBytes(Buffer.from(publicInputs, "hex")),
          StellarSdk.xdr.ScVal.scvBytes(Buffer.from(proof, "hex")),
        ),
      )
      .setTimeout(60)
      .build();

    const sim = await server.simulateTransaction(tx);
    if (StellarSdk.rpc.Api.isSimulationError(sim)) {
      return NextResponse.json(
        { error: `Withdrawal simulation failed: ${sim.error}` },
        { status: 400 },
      );
    }

    const assembled = StellarSdk.rpc.assembleTransaction(tx, sim).build();
    assembled.sign(relayer);

    const sent = await server.sendTransaction(assembled);
    if (sent.status === "ERROR") {
      return NextResponse.json(
        { error: "Relayed withdrawal submission failed." },
        { status: 500 },
      );
    }

    let result = await server.getTransaction(sent.hash);
    let tries = 0;
    while (result.status === "NOT_FOUND" && tries < 30) {
      await new Promise((r) => setTimeout(r, 1000));
      result = await server.getTransaction(sent.hash);
      tries++;
    }
    if (result.status !== "SUCCESS") {
      return NextResponse.json(
        { error: `Relayed withdrawal did not succeed (${result.status}).` },
        { status: 500 },
      );
    }

    return NextResponse.json({ hash: sent.hash, relayer: relayer.publicKey() });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("Relay withdraw failed:", message);
    return NextResponse.json(
      { error: `Relayed withdrawal failed: ${message}` },
      { status: 500 },
    );
  }
}
