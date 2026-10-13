import { Controller, Get, Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { SERVICE_URLS } from '@turnos/common';

/** /health del gateway: también reporta el estado de cada servicio. */
@Controller('health')
class HealthController {
  @Get()
  async health() {
    const services = Object.fromEntries(
      await Promise.all(
        Object.entries(SERVICE_URLS).map(async ([name, url]) => {
          const ok = await fetch(`${url()}/health`, { signal: AbortSignal.timeout(2_000) })
            .then((r) => r.ok)
            .catch(() => false);
          return [name, ok ? 'ok' : 'down'] as const;
        }),
      ),
    );
    return { status: Object.values(services).every((s) => s === 'ok') ? 'ok' : 'degraded', services };
  }
}

@Module({
  imports: [JwtModule.registerAsync({ useFactory: () => ({ secret: process.env.JWT_SECRET ?? 'dev-secret' }) })],
  controllers: [HealthController],
})
export class AppModule {}
