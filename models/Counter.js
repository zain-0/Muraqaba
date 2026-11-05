import mongoose from 'mongoose';

const CounterSchema = new mongoose.Schema({ _id: String, seq: { type: Number, default: 0 } });
const Counter = mongoose.model('Counter', CounterSchema);

/** The next VSR number. The increment is atomic, so two VSRs raised at once cannot share one. */
export const nextVsrNumber = async () => {
  const { seq } = await Counter.findByIdAndUpdate('vsr', { $inc: { seq: 1 } }, { new: true, upsert: true });
  return `VSR-${String(seq).padStart(4, '0')}`;
};

export default Counter;
