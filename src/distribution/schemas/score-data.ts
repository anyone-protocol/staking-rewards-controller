import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose'
import { HydratedDocument } from 'mongoose'

export type ScoreDataDocument = HydratedDocument<ScoreData>

@Schema()
export class ScoreData {
  @Prop({ type: String, required: true })
  Hodler: string

  @Prop({ type: String, required: true })
  Operator: string

  @Prop({ type: String, required: true })
  Staked: string

  @Prop({ type: Number, required: true })
  Running: number
}

export const ScoreDataSchema = SchemaFactory.createForClass(ScoreData)
