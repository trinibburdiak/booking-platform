import { BadRequestException, PipeTransform } from '@nestjs/common';
import { ZodSchema } from 'zod';

/** Valida con los mismos esquemas Zod que usa el front (libs/contracts). */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      const issues = result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
      throw new BadRequestException({
        statusCode: 400,
        message: issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join('; '),
        code: 'VALIDATION_ERROR',
        issues,
      });
    }
    return result.data;
  }
}
