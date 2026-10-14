import { Body, Controller, ForbiddenException, Get, Headers, HttpCode, Logger, NotFoundException, Param, ParseUUIDPipe, Post, Query, Res, UnauthorizedException, UseGuards } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { AuthUser, CurrentUser, UserGuard } from '@turnos/common';
import { Response } from 'express';
import { PaymentsService } from './payments.service';
import { bookingPage, verifyMercadoPagoSignature } from './providers';

const uuid = new ParseUUIDPipe();
const money = (cents: number) =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(cents / 100);

@ApiTags('payments')
@Controller()
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name);

  constructor(private readonly payments: PaymentsService) {}

  @Get('payments/booking/:bookingId')
  @UseGuards(UserGuard)
  forBooking(@CurrentUser() user: AuthUser, @Param('bookingId', uuid) bookingId: string) {
    return this.payments.forBooking(user, bookingId);
  }

  /**
   * Webhook de Mercado Pago. Se verifica la firma (si hay MP_WEBHOOK_SECRET) y se
   * consulta el pago a la API de MP: el body nunca se usa como fuente de verdad.
   */
  @Post('webhooks/mercadopago')
  @HttpCode(200)
  async mercadoPago(
    @Body() body: { type?: string; data?: { id?: string | number } },
    @Query('data.id') queryId: string | undefined,
    @Query('type') queryType: string | undefined,
    @Headers('x-signature') signature: string | undefined,
    @Headers('x-request-id') requestId: string | undefined,
  ) {
    const type = body?.type ?? queryType;
    const id = String(body?.data?.id ?? queryId ?? '');
    if (type !== 'payment' || !id) return { ignored: true };
    const secret = process.env.MP_WEBHOOK_SECRET;
    if (secret && !verifyMercadoPagoSignature({ secret, signature, requestId, dataId: id })) {
      throw new UnauthorizedException('Firma inválida');
    }
    const payment = await this.payments.handleMercadoPagoNotification(id);
    return { status: payment.status };
  }

  // ---------- checkout simulado (solo sin credenciales de Mercado Pago) ----------

  private async sandboxPayment(id: string) {
    if (this.payments.provider.name !== 'sandbox') throw new ForbiddenException('El checkout simulado está desactivado');
    return this.payments.getById(id);
  }

  @Get('payments/sandbox/:id')
  async sandboxPage(@Param('id', uuid) id: string, @Res() res: Response) {
    const p = await this.sandboxPayment(id).catch(() => null);
    if (!p) throw new NotFoundException('Pago no encontrado');
    const done = p.status !== 'CREATED';
    res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Checkout de prueba</title>
<style>body{font-family:system-ui,sans-serif;background:#f5f5f4;margin:0;display:grid;place-items:center;min-height:100vh;color:#1c1917}
.card{background:#fff;border-radius:16px;padding:28px;max-width:380px;width:calc(100% - 32px);box-shadow:0 1px 3px #0001}
.tag{display:inline-block;background:#fef3c7;color:#92400e;font-size:12px;padding:2px 8px;border-radius:99px}
h1{font-size:20px;margin:12px 0 4px}.amount{font-size:32px;font-weight:700;margin:12px 0 20px}
button{width:100%;padding:12px;border-radius:10px;border:0;font-size:15px;font-weight:600;cursor:pointer;margin-top:8px}
.ok{background:#256449;color:#fff}.ko{background:#fff;color:#b91c1c;border:1px solid #fecaca}p{color:#57534e;font-size:14px}</style></head>
<body><main class="card"><span class="tag">Checkout simulado · sin plata real</span>
<h1>Seña del turno</h1><div class="amount">${money(p.amountCents)}</div>
${
  done
    ? `<p>Este pago ya está <b>${p.status === 'APPROVED' ? 'aprobado' : p.status === 'REJECTED' ? 'rechazado' : p.status.toLowerCase()}</b>.</p><a href="${bookingPage(p.bookingId)}">Volver al turno</a>`
    : `<p>Elegí cómo termina el pago. En producción acá estaría Mercado Pago.</p>
<form method="post" action="/api/v1/payments/sandbox/${p.id}/approve"><button class="ok">Pagar (aprobar)</button></form>
<form method="post" action="/api/v1/payments/sandbox/${p.id}/reject"><button class="ko">Rechazar el pago</button></form>`
}
</main></body></html>`);
  }

  @Post('payments/sandbox/:id/:result')
  async sandboxResult(@Param('id', uuid) id: string, @Param('result') result: string, @Res() res: Response) {
    if (result !== 'approve' && result !== 'reject') throw new NotFoundException();
    await this.sandboxPayment(id);
    const p = await this.payments.applyResult(id, result === 'approve' ? 'approved' : 'rejected', `sandbox-${id}`, 'Rechazado en el checkout simulado');
    this.logger.log(`Pago simulado ${id}: ${p.status}`);
    res.redirect(303, `${bookingPage(p.bookingId)}?pago=${p.status === 'APPROVED' ? 'aprobado' : 'rechazado'}`);
  }
}
