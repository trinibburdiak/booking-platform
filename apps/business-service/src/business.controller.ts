import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiHeader, ApiTags } from '@nestjs/swagger';
import {
  CreateBusinessInput,
  createBusinessSchema,
  ExceptionInput,
  exceptionSchema,
  ProfessionalInput,
  professionalSchema,
  ScheduleInput,
  scheduleSchema,
  ServiceInput,
  serviceSchema,
  UpdateBusinessInput,
  updateBusinessSchema,
} from '@turnos/contracts';
import { AuthUser, CurrentTenant, CurrentUser, Roles, Tenant, TenantGuard, UserGuard, ZodPipe } from '@turnos/common';
import { BusinessService } from './business.service';

const uuid = new ParseUUIDPipe();

@ApiTags('public')
@Controller('public/businesses')
export class PublicBusinessController {
  constructor(private readonly business: BusinessService) {}

  @Get(':slug')
  get(@Param('slug') slug: string) {
    return this.business.getPublic(slug);
  }
}

@ApiTags('business')
@ApiBearerAuth()
@Controller('businesses')
@UseGuards(UserGuard)
export class BusinessesController {
  constructor(private readonly business: BusinessService) {}

  /** Crea un negocio; quien lo crea queda como OWNER. */
  @Post()
  create(@CurrentUser() user: AuthUser, @Body(new ZodPipe(createBusinessSchema)) body: CreateBusinessInput) {
    return this.business.create(user, body);
  }
}

@ApiTags('business')
@ApiBearerAuth()
@ApiHeader({ name: 'X-Business-Id', required: true })
@Controller('business')
@UseGuards(TenantGuard)
export class BusinessManagementController {
  constructor(private readonly business: BusinessService) {}

  @Get()
  get(@CurrentTenant() t: Tenant) {
    return this.business.get(t.businessId);
  }

  @Patch()
  @Roles('OWNER')
  update(@CurrentTenant() t: Tenant, @Body(new ZodPipe(updateBusinessSchema)) body: UpdateBusinessInput) {
    return this.business.update(t.businessId, body);
  }

  // profesionales

  @Get('professionals')
  listProfessionals(@CurrentTenant() t: Tenant) {
    return this.business.listProfessionals(t.businessId);
  }

  @Post('professionals')
  @Roles('OWNER')
  createProfessional(@CurrentTenant() t: Tenant, @Body(new ZodPipe(professionalSchema)) body: ProfessionalInput) {
    return this.business.createProfessional(t.businessId, body);
  }

  @Put('professionals/:id')
  @Roles('OWNER')
  updateProfessional(
    @CurrentTenant() t: Tenant,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(professionalSchema)) body: ProfessionalInput,
  ) {
    return this.business.updateProfessional(t.businessId, id, body);
  }

  @Delete('professionals/:id')
  @Roles('OWNER')
  deleteProfessional(@CurrentTenant() t: Tenant, @Param('id', uuid) id: string) {
    return this.business.deleteProfessional(t.businessId, id);
  }

  // servicios

  @Get('services')
  listServices(@CurrentTenant() t: Tenant) {
    return this.business.listServices(t.businessId);
  }

  @Post('services')
  @Roles('OWNER')
  createService(@CurrentTenant() t: Tenant, @Body(new ZodPipe(serviceSchema)) body: ServiceInput) {
    return this.business.createService(t.businessId, body);
  }

  @Put('services/:id')
  @Roles('OWNER')
  updateService(
    @CurrentTenant() t: Tenant,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(serviceSchema)) body: ServiceInput,
  ) {
    return this.business.updateService(t.businessId, id, body);
  }

  @Delete('services/:id')
  @Roles('OWNER')
  deleteService(@CurrentTenant() t: Tenant, @Param('id', uuid) id: string) {
    return this.business.deleteService(t.businessId, id);
  }

  // horario semanal y excepciones (owner o el propio staff)

  @Get('professionals/:id/schedule')
  getSchedule(@CurrentTenant() t: Tenant, @CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.business.getSchedule(t, u, id);
  }

  @Put('professionals/:id/schedule')
  setSchedule(
    @CurrentTenant() t: Tenant,
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(scheduleSchema)) body: ScheduleInput,
  ) {
    return this.business.setSchedule(t, u, id, body);
  }

  @Get('professionals/:id/exceptions')
  listExceptions(@CurrentTenant() t: Tenant, @CurrentUser() u: AuthUser, @Param('id', uuid) id: string) {
    return this.business.listExceptions(t, u, id);
  }

  @Post('professionals/:id/exceptions')
  createException(
    @CurrentTenant() t: Tenant,
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Body(new ZodPipe(exceptionSchema)) body: ExceptionInput,
  ) {
    return this.business.createException(t, u, id, body);
  }

  @Delete('professionals/:id/exceptions/:exceptionId')
  @HttpCode(204)
  deleteException(
    @CurrentTenant() t: Tenant,
    @CurrentUser() u: AuthUser,
    @Param('id', uuid) id: string,
    @Param('exceptionId', uuid) exceptionId: string,
  ) {
    return this.business.deleteException(t, u, id, exceptionId);
  }
}
