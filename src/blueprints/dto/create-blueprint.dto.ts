import { ApiProperty } from "@nestjs/swagger";
import { IsInt, IsObject, IsOptional, IsString, Min } from "class-validator";

export class CreateBlueprintDto {
  @ApiProperty()
  @IsString()
  documentId: string;

  @ApiProperty({ example: "Paket Latihan Bab 1" })
  @IsString()
  title: string;

  @ApiProperty({ example: 40 })
  @IsInt()
  @Min(1)
  total: number;

  @ApiProperty({ example: 30 })
  @IsInt()
  @Min(0)
  mcqCount: number;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(0)
  essayCount: number;

  @ApiProperty({ example: { LOTS: 16, MOTS: 16, HOTS: 8 } })
  @IsObject()
  cognitive: { LOTS: number; MOTS: number; HOTS: number };

  @ApiProperty({ example: { EASY: 14, MEDIUM: 18, HARD: 8 } })
  @IsObject()
  difficulty: { EASY: number; MEDIUM: number; HARD: number };

  @ApiProperty({ required: false, example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  topKContext?: number;
}