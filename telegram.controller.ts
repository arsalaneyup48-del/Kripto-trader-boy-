import { Controller, Post, Body, Logger, HttpCode } from '@nestjs/common';
import { ApiTags, ApiOperation } from '@nestjs/swagger';
import { TelegramService } from './telegram.service';
import { LlmService } from '../llm/llm.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('Telegram Webhook')
@Controller('webhook')
export class TelegramController {
  private readonly logger = new Logger(TelegramController.name);

  constructor(
    private readonly telegram: TelegramService,
    private readonly llm: LlmService,
    private readonly prisma: PrismaService,
  ) {}

  @Post('telegram')
  @HttpCode(200)
  @ApiOperation({ summary: 'Telegram webhook endpoint' })
  async handleWebhook(@Body() body: any): Promise<{ ok: boolean }> {
    const message = body?.message;
    if (!message) return { ok: true };

    const chatId = message.chat?.id;
    const userId = String(message.from?.id || chatId);
    const text = message.text?.trim() || '';
    const photo = message.photo;

    this.logger.log(`Mesaj alındı: userId=${userId}, text="${text}", hasPhoto=${!!photo}`);

    // Process asynchronously so we respond to Telegram quickly
    setImmediate(() => this.processMessage(chatId, userId, text, photo, message.caption));

    return { ok: true };
  }

  private async processMessage(
    chatId: number,
    userId: string,
    text: string,
    photo: any[] | undefined,
    caption?: string,
  ): Promise<void> {
    try {
      // Ensure user settings exist
      await this.prisma.user_settings.upsert({
        where: { user_id: userId },
        create: { user_id: userId },
        update: {},
      });

      // Remember this chat for auto-patrol alerts
      await this.prisma.telegram_chat.upsert({
        where: { chat_id: String(chatId) },
        create: { chat_id: String(chatId), user_id: userId },
        update: { user_id: userId },
      });

      // Check for instruction commands
      if (this.isInstructionCommand(text)) {
        await this.handleInstruction(chatId, userId, text);
        return;
      }

      let response;

      if (photo && photo.length > 0) {
        // Photo message — get highest resolution
        const fileId = photo[photo.length - 1].file_id;
        const base64 = await this.telegram.getFileBase64(fileId);
        response = await this.llm.analyzeImage(userId, base64, caption);
      } else if (text) {
        // Save user message
        await this.prisma.chat_message.create({
          data: { user_id: userId, message: text, role: 'user' },
        });
        response = await this.llm.analyzeMarket(userId, text);
      } else {
        return;
      }

      // Format and send response
      let replyText = response.text;
      if (response.tradeCard) {
        replyText = this.telegram.formatTradeCard(response.tradeCard);
        if (response.text) {
          replyText = response.text + '\n\n' + replyText;
        }
      }

      await this.telegram.sendMessage(chatId, replyText);

      // Save assistant response
      await this.prisma.chat_message.create({
        data: {
          user_id: userId,
          message: replyText.substring(0, 4000),
          role: 'assistant',
        },
      });
    } catch (err: any) {
      this.logger.error(`Mesaj işleme hatası: ${err.message}`, err.stack);
      await this.telegram.sendMessage(chatId, '⚠️ Bir hata oluştu, lütfen tekrar dene.');
    }
  }

  private isInstructionCommand(text: string): boolean {
    const lower = text.toLowerCase();
    return (
      lower.startsWith('bundan sonra') ||
      lower.startsWith('kural:') ||
      lower.startsWith('talimat:') ||
      lower.startsWith('artık')
    );
  }

  private async handleInstruction(chatId: number, userId: string, text: string): Promise<void> {
    await this.prisma.user_instruction.create({
      data: { user_id: userId, instruction: text },
    });
    await this.telegram.sendMessage(
      chatId,
      `✅ Talimat kaydedildi ve bundan sonraki tüm kararlarıma uygulanacak:\n\n<i>"${text}"</i>`,
    );
  }
}
