import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

export interface CoinTicker {
  symbol: string;
  price: number;
  change24h: number;
  volume: number;
}

export interface MarketSnapshot {
  btc: CoinTicker;
  eth: CoinTicker;
  sol: CoinTicker;
  top50: CoinTicker[];
  fearGreedIndex: { value: number; classification: string };
  fetchedAt: Date;
}

@Injectable()
export class MarketDataService {
  private readonly logger = new Logger(MarketDataService.name);
  private cache: MarketSnapshot | null = null;
  private cacheExpiry = 0;
  private readonly CACHE_TTL = 60_000; // 60s

  async getMarketSnapshot(): Promise<MarketSnapshot> {
    if (this.cache && Date.now() < this.cacheExpiry) {
      return this.cache;
    }
    const [tickers, fearGreed] = await Promise.all([
      this.fetchTickers(),
      this.fetchFearGreed(),
    ]);

    const findCoin = (sym: string) =>
      tickers.find((t) => t.symbol === sym) || { symbol: sym, price: 0, change24h: 0, volume: 0 };

    const snapshot: MarketSnapshot = {
      btc: findCoin('BTCUSDT'),
      eth: findCoin('ETHUSDT'),
      sol: findCoin('SOLUSDT'),
      top50: tickers.slice(0, 50),
      fearGreedIndex: fearGreed,
      fetchedAt: new Date(),
    };
    this.cache = snapshot;
    this.cacheExpiry = Date.now() + this.CACHE_TTL;
    return snapshot;
  }

  private async fetchTickers(): Promise<CoinTicker[]> {
    // Primary: Binance public data mirror (data-api.binance.vision) — not geo-blocked
    try {
      return await this.fetchFromBinanceVision();
    } catch (e) {
      this.logger.warn('Binance data-api başarısız, OKX deneniyor...');
    }

    // Fallback 1: OKX perpetual swaps (real futures)
    try {
      return await this.fetchFromOkx();
    } catch (e) {
      this.logger.warn('OKX API başarısız, CoinGecko deneniyor...');
    }

    // Fallback 2: CoinGecko
    try {
      return await this.fetchFromCoinGecko();
    } catch (e) {
      this.logger.error('Tüm veri kaynakları başarısız!');
      return [];
    }
  }

  private async fetchFromBinanceVision(): Promise<CoinTicker[]> {
    const { data } = await axios.get(
      'https://data-api.binance.vision/api/v3/ticker/24hr',
      { timeout: 10000 },
    );
    const tickers: CoinTicker[] = data
      .filter((t: any) => t.symbol.endsWith('USDT'))
      .map((t: any) => ({
        symbol: t.symbol,
        price: parseFloat(t.lastPrice),
        change24h: parseFloat(t.priceChangePercent),
        volume: parseFloat(t.quoteVolume),
      }))
      .filter((t: CoinTicker) => t.price > 0)
      .sort((a: CoinTicker, b: CoinTicker) => b.volume - a.volume);
    this.logger.log(`Binance (data-api): ${tickers.length} coin çekildi`);
    return tickers;
  }

  private async fetchFromOkx(): Promise<CoinTicker[]> {
    const { data } = await axios.get(
      'https://www.okx.com/api/v5/market/tickers?instType=SWAP',
      { timeout: 10000 },
    );
    const tickers: CoinTicker[] = (data.data || [])
      .filter((t: any) => (t.instId as string).endsWith('-USDT-SWAP'))
      .map((t: any) => {
        const price = parseFloat(t.last) || 0;
        const open = parseFloat(t.open24h) || price;
        const volCoin = parseFloat(t.volCcy24h) || 0;
        return {
          symbol: (t.instId as string).replace('-USDT-SWAP', '') + 'USDT',
          price,
          change24h: open > 0 ? ((price - open) / open) * 100 : 0,
          volume: volCoin * price,
        };
      })
      .filter((t: CoinTicker) => t.price > 0)
      .sort((a: CoinTicker, b: CoinTicker) => b.volume - a.volume);
    this.logger.log(`OKX SWAP: ${tickers.length} coin çekildi`);
    return tickers;
  }

  private async fetchFromCoinGecko(): Promise<CoinTicker[]> {
    const { data } = await axios.get(
      'https://api.coingecko.com/api/v3/coins/markets',
      {
        params: {
          vs_currency: 'usd',
          order: 'volume_desc',
          per_page: 50,
          page: 1,
          sparkline: false,
        },
        timeout: 10000,
      },
    );
    return data.map((c: any) => ({
      symbol: (c.symbol as string).toUpperCase() + 'USDT',
      price: c.current_price ?? 0,
      change24h: c.price_change_percentage_24h ?? 0,
      volume: c.total_volume ?? 0,
    }));
  }

  private async fetchFearGreed(): Promise<{ value: number; classification: string }> {
    try {
      const { data } = await axios.get('https://api.alternative.me/fng/', { timeout: 8000 });
      const entry = data.data?.[0];
      return {
        value: parseInt(entry?.value ?? '50', 10),
        classification: entry?.value_classification ?? 'Neutral',
      };
    } catch {
      this.logger.warn('Fear & Greed Index alınamadı, varsayılan kullanılıyor');
      return { value: 50, classification: 'Neutral' };
    }
  }
}
