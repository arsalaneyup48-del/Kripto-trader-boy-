import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { MarketDataService, MarketSnapshot } from '../market-data/market-data.service';
import axios from 'axios';

export interface TradeCard {
  parity: string;
  direction: 'LONG' | 'SHORT';
  leverage: number;
  margin: number;
  entry: number;
  stopLoss: number;
  takeProfit: number;
  confidence: number;
  potentialProfit: number;
  potentialProfitPct: number;
  reasoning: string;
}

export interface LlmResponse {
  text: string;
  tradeCard?: TradeCard;
}

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly apiKey: string;
  private readonly apiUrl = 'https://apps.abacus.ai/v1/chat/completions';

  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
    private readonly marketData: MarketDataService,
  ) {
    this.apiKey = this.config.get<string>('ABACUSAI_API_KEY') || '';
  }

  private async buildSystemPrompt(userId: string): Promise<string> {
    // Fetch user instructions from DB
    const instructions = await this.prisma.user_instruction.findMany({
      where: { user_id: userId, active: true },
    });

    const settings = await this.prisma.user_settings.upsert({
      where: { user_id: userId },
      create: { user_id: userId },
      update: {},
    });

    const instructionBlock = instructions.length > 0
      ? `\n\nKULLANICI TALİMATLARI (bunlara MUTLAKA uy):\n${instructions.map((i) => `- ${i.instruction}`).join('\n')}`
      : '';

    return `Sen profesyonel bir kripto futures trading asistanısın. Türkçe konuşursun. Cesur ama disiplinli, enerjik ve motive edici bir tarzın var.

KULLANICI DURUMU:
- Bakiye: ${settings.balance} USDT
- Maksimum Kaldıraç: ${settings.max_leverage}x
- Kill Switch: ${settings.is_kill_switch_active ? 'AKTİF - İŞLEM ÖNERİSİ YAPMA!' : 'Pasif'}

DEĞİŞMEZ KURALLAR (ASLA ihlal etme):
1. Her işlemde MUTLAKA stop-loss + take-profit olmalı
2. Her zaman ISOLATED margin
3. Martingale YASAK
4. KILL SWITCH: Bakiye 100 USDT altına düşerse durdur
5. Kaldıraç 1x-10x arası, pozisyon max %50
6. Emin değilsen "şu an işlem yok" de

MESAJ FORMAT KURALLARI (ÇOK ÖNEMLİ - MUTLAKA UY):
- Mesajlar Telegram'da gösterilecek. HTML formatı kullan (<b>, <i> gibi).
- ASLA Markdown kullanma (**, __, ## yasak).
- Mesajları KISA tut. Gereksiz açıklama yapma.
- Emoji kullan ama abartma.
- Tablo KULLANMA. Madde işareti (• veya -) kullan.
- Satır başı için gerçek satır sonu karakteri kullan, literal \\n YAZMA.

JSON FORMATI:
Bir işlem önerdiğinde:
{
  "text": "kısa açıklama",
  "tradeCard": {
    "parity": "XXXUSDT",
    "direction": "LONG" veya "SHORT",
    "leverage": sayı (1-10),
    "margin": sayı (USDT),
    "entry": sayı,
    "stopLoss": sayı,
    "takeProfit": sayı,
    "confidence": sayı (1-10),
    "potentialProfit": sayı (USDT),
    "potentialProfitPct": sayı (%),
    "reasoning": "kısa gerekçe"
  }
}

İşlem yoksa:
{
  "text": "kısa açıklama",
  "tradeCard": null
}

Her zaman JSON formatında cevap ver.${instructionBlock}`;
  }

  async analyzeMarket(userId: string, userMessage: string): Promise<LlmResponse> {
    const snapshot = await this.marketData.getMarketSnapshot();
    const systemPrompt = await this.buildSystemPrompt(userId);

    const marketSummary = this.formatMarketSummary(snapshot);

    // Build recent chat history
    const history = await this.prisma.chat_message.findMany({
      where: { user_id: userId },
      orderBy: { created_at: 'desc' },
      take: 10,
    });

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
    ];

    // Add recent history in chronological order
    for (const h of history.reverse()) {
      messages.push({ role: h.role as 'user' | 'assistant', content: h.message });
    }

    messages.push({
      role: 'user',
      content: `GÜNCEL PİYASA VERİSİ:\n${marketSummary}\n\nKullanıcı mesajı: ${userMessage}`,
    });

    return this.callLlm(messages);
  }

  async analyzeImage(userId: string, imageBase64: string, caption?: string): Promise<LlmResponse> {
    const snapshot = await this.marketData.getMarketSnapshot();
    const systemPrompt = await this.buildSystemPrompt(userId);
    const marketSummary = this.formatMarketSummary(snapshot);

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${imageBase64}` },
          },
          {
            type: 'text',
            text: `GÜNCEL PİYASA VERİSİ:\n${marketSummary}\n\n${caption ? `Kullanıcı mesajı: ${caption}` : 'Bu ekran görüntüsünü analiz et ve işlem önerisi ver.'}`,
          },
        ],
      },
    ];

    return this.callLlm(messages);
  }

  async patrolScan(): Promise<LlmResponse> {
    const snapshot = await this.marketData.getMarketSnapshot();
    const systemPrompt = await this.buildSystemPrompt('patrol');
    const marketSummary = this.formatMarketSummary(snapshot);

    const messages: any[] = [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: `OTOMATİK TARAMA MODU

GÜNCEL PİYASA VERİSİ:
${marketSummary}

Tüm coinleri tara. Kontrol et:
1. Son 24 saatte %5'ten fazla hareket edenler
2. Güven ≥ 7 olan işlem fırsatları

Fırsat varsa trade card JSON döndür. Yoksa kısa belirt.
HATIRLA: text alanında HTML formatı kullan, Markdown kullanma, KISA yaz.`,
      },
    ];

    return this.callLlm(messages);
  }

  private async callLlm(messages: any[]): Promise<LlmResponse> {
    try {
      const { data } = await axios.post(
        this.apiUrl,
        {
          model: 'claude-sonnet-4-6',
          messages,
          response_format: { type: 'json_object' },
          stream: false,
          max_tokens: 2000,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          timeout: 60000,
        },
      );

      const content = data.choices?.[0]?.message?.content || '{}';
      this.logger.log(`LLM yanıtı alındı (${content.length} karakter)`);

      try {
        const parsed = JSON.parse(content);
        return {
          text: parsed.text || 'Bir hata oluştu.',
          tradeCard: parsed.tradeCard || undefined,
        };
      } catch {
        return { text: content };
      }
    } catch (err: any) {
      this.logger.error(`LLM API hatası: ${err.message}`);
      return { text: '⚠️ Yapay zeka şu an yanıt veremiyor, lütfen biraz sonra tekrar dene.' };
    }
  }

  private formatMarketSummary(snapshot: MarketSnapshot): string {
    const lines: string[] = [
      `📊 Piyasa Özeti (${snapshot.fetchedAt.toISOString()})`,
      `Fear & Greed: ${snapshot.fearGreedIndex.value}/100 (${snapshot.fearGreedIndex.classification})`,
      '',
      `BTC: $${snapshot.btc.price.toLocaleString()} (${snapshot.btc.change24h > 0 ? '+' : ''}${snapshot.btc.change24h.toFixed(2)}%)`,
      `ETH: $${snapshot.eth.price.toLocaleString()} (${snapshot.eth.change24h > 0 ? '+' : ''}${snapshot.eth.change24h.toFixed(2)}%)`,
      `SOL: $${snapshot.sol.price.toLocaleString()} (${snapshot.sol.change24h > 0 ? '+' : ''}${snapshot.sol.change24h.toFixed(2)}%)`,
      '',
      'Top 50 (Hacme göre):',
    ];

    for (const coin of snapshot.top50) {
      lines.push(`${coin.symbol}: $${coin.price} (${coin.change24h > 0 ? '+' : ''}${coin.change24h.toFixed(2)}%) Vol: $${(coin.volume / 1e6).toFixed(1)}M`);
    }

    return lines.join('\n');
  }
}
