import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Min } from "class-validator";

export class RetrievalSearchDto {
  @ApiProperty()
  @IsString()
  documentId: string;

  @ApiProperty()
  @IsString()
  query: string;

  @ApiProperty({ required: false, default: 5 })
  @IsOptional()
  @IsInt()
  @Min(1)
  topK?: number;
}