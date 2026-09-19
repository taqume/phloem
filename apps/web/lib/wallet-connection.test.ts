import assert from "node:assert/strict";
import test from "node:test";

import { requestWalletConnection, walletErrorMessage } from "./wallet-connection";

test("wallet access completes before the extension receives a network request", async () => {
  let accessCompleted = false;
  const connection = await requestWalletConnection({
    async fetchAddress() {
      await new Promise((resolve) => setTimeout(resolve, 5));
      accessCompleted = true;
      return { address: "GTEST" };
    },
    async getNetwork() {
      assert.equal(accessCompleted, true, "network request raced the Freighter access prompt");
      return { network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" };
    },
  });

  assert.equal(connection.address, "GTEST");
});

test("wallet connection stops waiting when an extension request never settles", async () => {
  await assert.rejects(
    requestWalletConnection({
      fetchAddress: () => new Promise(() => undefined),
      async getNetwork() {
        return { network: "TESTNET", networkPassphrase: "Test SDF Network ; September 2015" };
      },
    }, 5),
    /Freighter did not respond/,
  );
});

test("wallet errors preserve messages returned as extension error objects", () => {
  assert.equal(walletErrorMessage({ message: "User declined access" }, "fallback"), "User declined access");
});
