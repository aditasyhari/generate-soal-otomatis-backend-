import { Body, Controller, Get, Param, Post } from "@nestjs/common";
import { ApiTags } from "@nestjs/swagger";
import { BlueprintsService } from "./blueprints.service";
import { CreateBlueprintDto } from "./dto/create-blueprint.dto";

@ApiTags("blueprints")
@Controller("blueprints")
export class BlueprintsController {
  constructor(private readonly service: BlueprintsService) {}

  @Post()
  create(@Body() dto: CreateBlueprintDto) {
    return this.service.create(dto);
  }

  @Post(":id/build")
  build(@Param("id") id: string) {
    return this.service.buildItems(id);
  }

  @Get(":id")
  get(@Param("id") id: string) {
    return this.service.get(id);
  }
}