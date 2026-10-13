import { z } from 'zod';

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato HH:mm');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Formato YYYY-MM-DD');
const slug = z
  .string()
  .min(3)
  .max(40)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'Solo minúsculas, números y guiones');

// ---------- Auth ----------

export const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8, 'Mínimo 8 caracteres'),
  fullName: z.string().min(2),
  phone: z.string().optional(),
});
export type RegisterInput = z.infer<typeof registerSchema>;

export const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});
export type LoginInput = z.infer<typeof loginSchema>;

export type Role = 'OWNER' | 'STAFF';

export interface MeResponse {
  id: string;
  email: string;
  fullName: string;
  phone: string | null;
  memberships: { businessId: string; role: Role; businessName: string; businessSlug: string }[];
}

export interface AuthResponse {
  accessToken: string;
  user: MeResponse;
}

// ---------- Business ----------

export const createBusinessSchema = z.object({
  name: z.string().min(2),
  slug,
  timezone: z.string().min(3).default('America/Argentina/Cordoba'),
  address: z.string().optional(),
});
export type CreateBusinessInput = z.infer<typeof createBusinessSchema>;

export const updateBusinessSchema = z.object({
  name: z.string().min(2).optional(),
  timezone: z.string().min(3).optional(),
  address: z.string().nullable().optional(),
  cancellationHours: z.number().int().min(0).max(720).optional(),
  bookingWindowDays: z.number().int().min(1).max(365).optional(),
  minNoticeMinutes: z.number().int().min(0).max(10080).optional(),
});
export type UpdateBusinessInput = z.infer<typeof updateBusinessSchema>;

export const professionalSchema = z.object({
  displayName: z.string().min(2),
  active: z.boolean().default(true),
  serviceIds: z.array(z.string().uuid()).default([]),
});
export type ProfessionalInput = z.infer<typeof professionalSchema>;

export const serviceSchema = z.object({
  name: z.string().min(2),
  durationMin: z.number().int().min(5).max(600),
  bufferMin: z.number().int().min(0).max(240).default(0),
  priceCents: z.number().int().min(0),
  depositCents: z.number().int().min(0).default(0),
  active: z.boolean().default(true),
});
export type ServiceInput = z.infer<typeof serviceSchema>;

export const weeklyRangeSchema = z.object({
  weekday: z.number().int().min(0).max(6),
  startTime: time,
  endTime: time,
});
export const scheduleSchema = z.object({ ranges: z.array(weeklyRangeSchema).max(50) });
export type ScheduleInput = z.infer<typeof scheduleSchema>;

/** Los inputs vacíos de un formulario llegan como "": se tratan como ausentes. */
const optionalTime = z.preprocess((v) => (v === '' || v === null ? undefined : v), time.optional());

export const exceptionSchema = z
  .object({
    date: isoDate,
    type: z.enum(['CLOSED', 'EXTRA_HOURS']),
    startTime: optionalTime,
    endTime: optionalTime,
    reason: z.string().max(200).optional(),
  })
  .refine((e) => e.type === 'CLOSED' || (e.startTime && e.endTime), {
    message: 'Las horas extra necesitan inicio y fin',
    path: ['startTime'],
  })
  .refine((e) => !!e.startTime === !!e.endTime, { message: 'Indicá inicio y fin, o ninguno', path: ['startTime'] });
export type ExceptionInput = z.infer<typeof exceptionSchema>;

export interface PublicBusiness {
  id: string;
  slug: string;
  name: string;
  timezone: string;
  address: string | null;
  cancellationHours: number;
  services: { id: string; name: string; durationMin: number; priceCents: number; professionalIds: string[] }[];
  professionals: { id: string; displayName: string }[];
}

// ---------- Availability & bookings ----------

export const availabilityQuerySchema = z.object({
  serviceId: z.string().uuid(),
  professionalId: z.string().uuid().optional(),
  date: isoDate,
});
export type AvailabilityQuery = z.infer<typeof availabilityQuerySchema>;

export interface AvailableSlot {
  start: string;
  end: string;
  localStart: string;
  localEnd: string;
  professionalId: string;
}

export interface AvailabilityResponse {
  date: string;
  timezone: string;
  slots: AvailableSlot[];
}

export const createBookingSchema = z.object({
  businessSlug: slug,
  serviceId: z.string().uuid(),
  /** Omitido = "cualquiera". */
  professionalId: z.string().uuid().optional(),
  start: z.string().datetime(),
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

export const rescheduleBookingSchema = z.object({
  start: z.string().datetime(),
  professionalId: z.string().uuid().optional(),
});
export type RescheduleBookingInput = z.infer<typeof rescheduleBookingSchema>;

export const attendanceSchema = z.object({ attended: z.boolean() });

export const agendaQuerySchema = z.object({
  from: z.string().datetime(),
  to: z.string().datetime(),
  professionalId: z.string().uuid().optional(),
});

export type BookingStatus = 'PENDING' | 'CONFIRMED' | 'CANCELLED' | 'EXPIRED' | 'ATTENDED' | 'NO_SHOW';

export interface BookingView {
  id: string;
  status: BookingStatus;
  start: string;
  end: string;
  priceCents: number;
  business: { id: string; slug: string; name: string; timezone: string; cancellationHours: number };
  service: { id: string; name: string; durationMin: number };
  professional: { id: string; displayName: string };
  client?: { id: string; fullName: string; email: string; phone: string | null };
  canClientCancel: boolean;
}

export interface ApiError {
  statusCode: number;
  message: string;
  code?: string;
}
