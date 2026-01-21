import { ApiProperty } from "@nestjs/swagger";
import { IsOptional, IsString } from "class-validator";

export class UploadDocumentDto {
  @ApiProperty({ example: "Materi Bab 1 - Hukum Newton" })
  @IsString()
  title: string;

  @ApiProperty({ required: false, example: "Fisika" })
  @IsOptional()
  @IsString()
  subject?: string;

  @ApiProperty({ required: false, example: "10" })
  @IsOptional()
  @IsString()
  grade?: string;

  @ApiProperty({ required: false, example: "id" })
  @IsOptional()
  @IsString()
  language?: string;
}