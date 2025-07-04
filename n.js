#!/usr/bin/env node
import axios from "axios";
import fs from "fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import chalk from "chalk";
import { ethers } from "ethers";
import ProxyAgent from "proxy-agent";
import { encode, toWords } from "bech32";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const FAUCET_API = "https://jsbqfdd4yk.execute-api.us-east-1.amazonaws.com/v2/faucet";
const INJECTIVE_RPC = "https://k8s.testnet.json-rpc.injective.network/";

const SEND_RATIO = 98; // % saldo yang dikirim setelah gas

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleString("id-ID", { timeZone: "Asia/Jakarta" });

const readLines = async (file) => {
  try {
    const txt = await fs.readFile(path.join(__dirname, file), "utf8");
    return txt.split(/\r?\n/).filter(Boolean);
  } catch {
    return [];
  }
};

const appendLines = async (file, lines) => {
  if (!lines.length) return;
  await fs.appendFile(path.join(__dirname, file), lines.join("\n") + "\n");
};

function evmToInj(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Alamat EVM tidak valid");
  const bytes = Buffer.from(address.slice(2), "hex");
  const words = toWords(bytes);
  return encode("inj", words);
}

async function generateWallets(howMany = 100) {  // Ubah jadi 100 wallet
  const privKeys = [];
  for (let i = 0; i < howMany; i++) {
    const wallet = ethers.Wallet.createRandom();
    privKeys.push(wallet.privateKey);
  }
  await appendLines("wallet.txt", privKeys);
  console.log(chalk.yellow.bold(`☑  ${howMany} wallet baru disimpan di wallet.txt`));
  return privKeys;
}

async function claimFaucet(evmAddress, proxy) {
  const injAddress = evmToInj(evmAddress);
  const agent = proxy ? new ProxyAgent(proxy) : undefined;

  try {
    const { status, data } = await axios.post(
      FAUCET_API,
      { address: injAddress },
      {
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          Origin: "https://multivm.injective.com",
          Referer: "https://multivm.injective.com",
          "User-Agent": "Mozilla/5.0 Injective-Bot",
        },
        httpsAgent: agent,
        httpAgent: agent,
        timeout: 60_000,
        validateStatus: () => true,
      }
    );

    if (status === 200) {
      console.log(chalk.green(`✓  ${injAddress} – Klaim berhasil`));
      return true;
    } else if (status === 400) {
      console.log(chalk.yellow(`•  ${injAddress} – Sudah diklaim`));
      return false;
    }
    console.log(chalk.red(`✗  ${injAddress} – Error ${status}: ${JSON.stringify(data)}`));
    return false;
  } catch (err) {
    console.log(chalk.red(`✗  ${injAddress} – ${err.message}`));
    return false;
  }
}

async function distributeFunds(privateKeys, provider, targets) {
  console.log(
    chalk.yellow("\n🔄 Mulai transfer otomatis ") + chalk.bold(`${SEND_RATIO}%`) + chalk.yellow(" ke target...\n")
  );

  for (const pk of privateKeys) {
    let wallet;
    try {
      wallet = new ethers.Wallet(pk, provider);
    } catch {
      console.log(chalk.red(`PK tidak valid → ${pk.slice(0, 6)}...`));
      continue;
    }

    const sender = wallet.address;
    let balance;
    try {
      balance = await provider.getBalance(sender);
    } catch (err) {
      console.log(chalk.red(`❌ Gagal mengambil balance ${sender}: ${err.message}`));
      continue;
    }

    if (balance === 0n) {
      console.log(chalk.gray(`•  Balance 0 – lewati ${sender}`));
      continue;
    }

    let feeData;
    try {
      feeData = await provider.getFeeData();
    } catch (err) {
      console.log(chalk.red("❌ Gagal mengambil FeeData:"), err.message);
      continue;
    }

    const gasPrice = feeData.gasPrice ?? 0n;
    const gasLimit = 21_000n;
    const totalGasPerTx = gasPrice * gasLimit;
    const gasBudget = totalGasPerTx * BigInt(targets.length);

    if (balance <= gasBudget) {
      console.log(chalk.red(`❌ Balance tidak cukup untuk gas (${sender})`));
      continue;
    }

    const distributable = ((balance - gasBudget) * BigInt(SEND_RATIO)) / 100n;
    const amountPerTarget = distributable / BigInt(targets.length);

    if (amountPerTarget === 0n) {
      console.log(chalk.red(`❌ Jumlah per target terlalu kecil (${sender})`));
      continue;
    }

    let nonce = await provider.getTransactionCount(sender, "latest");

    console.log(chalk.cyan(`🔑 Wallet: ${sender}`));
    console.log(chalk.blue(`💰 Balance: ${ethers.formatEther(balance)} ETH`));

    for (const target of targets) {
      if (!ethers.isAddress(target)) {
        console.log(chalk.red(`❌ Alamat target tidak valid: ${target}`));
        continue;
      }

      try {
        const tx = await wallet.sendTransaction({
          to: target,
          value: amountPerTarget,
          gasLimit,
          gasPrice,
          nonce,
        });

        console.log(
          chalk.green(
            `✓  ${ethers.formatEther(amountPerTarget)} ETH dikirim ke ${target} (hash ${tx.hash})`
          )
        );
        await tx.wait();
        nonce++;
      } catch (err) {
        console.log(chalk.red(`❌ Gagal kirim ke ${target}: ${err.message}`));
      }
    }
  }

  console.log(chalk.green("\n🎉 Semua transfer selesai!\n"));
}

async function loadProxies() {
  // Default: tanpa proxy
  return [];
}

(async () => {
  console.clear();
  console.log(chalk.green.bold("Auto‑Claim Faucet Injective + Auto‑Send BOT (100 Wallet per Siklus)"));

  const provider = new ethers.JsonRpcProvider(INJECTIVE_RPC);

  while (true) {
    // 1. Generate 100 wallet baru tiap siklus
    await generateWallets(100);

    // 2. Load semua wallet (lama + baru)
    const allPrivKeys = [...new Set(await readLines("wallet.txt"))].filter(Boolean);
    if (!allPrivKeys.length) {
      console.log(chalk.red("File wallet.txt kosong – keluar."));
      process.exit(1);
    }
    console.log(chalk.cyan(`Total wallet: ${allPrivKeys.length}`));

    // 3. Load target addresses
    const targets = (await readLines("address.txt")).filter((a) => ethers.isAddress(a));
    if (!targets.length) {
      console.log(chalk.red("File address.txt kosong / tidak ada alamat valid – keluar."));
      process.exit(1);
    }
    console.log(chalk.cyan(`Total target address: ${targets.length}`));

    // 4. Load proxies (default tanpa proxy)
    const proxies = await loadProxies();
    let proxyIndex = 0;
    const nextProxy = () => {
      if (!proxies.length) return null;
      const p = proxies[proxyIndex];
      proxyIndex = (proxyIndex + 1) % proxies.length;
      return /^https?:\/\//.test(p) ? p : `http://${p}`;
    };

    // 5. Klaim faucet untuk semua wallet
    console.log(chalk.blue.bold(`\n[${now()}] 🚰 Mulai proses klaim faucet...\n`));
    for (const pk of allPrivKeys) {
      let wallet;
      try {
        wallet = new ethers.Wallet(pk.trim());
      } catch {
        console.log(chalk.red(`PK tidak valid → ${pk.slice(0, 6)}...`));
        continue;
      }
      await claimFaucet(wallet.address, nextProxy());
      await sleep(1_000);
    }

    // 6. Tunggu 60 detik agar token masuk
    console.log(chalk.gray("\n⏳ Menunggu 60 detik agar token masuk ..."));
    await sleep(60_000);

    // 7. Distribusikan dana ke target
    console.log(chalk.blue.bold("\n🚀 Mulai distribusi ..."));
    await distributeFunds(allPrivKeys, provider, targets);

    // 8. Hapus file wallet.txt untuk menghapus wallet lama
    try {
      await fs.rm(path.join(__dirname, "wallet.txt"), { force: true });
      console.log(chalk.magenta("🗑️  wallet.txt berhasil dihapus (wallet lama dihapus)"));
    } catch (err) {
      console.log(chalk.red("❌ Gagal menghapus wallet.txt:"), err.message);
    }

    // Langsung lanjut siklus berikutnya tanpa delay
  }
})();
