"""
Convert downloaded CSV price data to Parquet format for DuckDB efficiency.
"""

import os
import glob
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq
from pathlib import Path
from typing import List, Optional


class CSVToParquetConverter:
    """Converter for CSV price data to Parquet format."""

    def __init__(self, raw_dir: str = "data/raw", parquet_dir: str = "data/parquet"):
        self.raw_dir = Path(raw_dir)
        self.parquet_dir = Path(parquet_dir)
        self.parquet_dir.mkdir(parents=True, exist_ok=True)

    def convert_file(self, input_path: str, output_path: Optional[str] = None) -> str:
        """
        Convert a single CSV file to Parquet.

        Args:
            input_path: Path to the input CSV file
            output_path: Optional output path for Parquet file

        Returns:
            Path to the created Parquet file
        """
        input_path = Path(input_path)

        if output_path is None:
            output_path = self.parquet_dir / f"{input_path.stem}.parquet"
        else:
            output_path = Path(output_path)

        # Read CSV
        df = pd.read_csv(input_path)

        # Convert to Arrow and write Parquet
        table = pa.Table.from_pandas(df)
        pq.write_table(table, output_path)

        print(f"Converted {input_path.name} -> {output_path.name}")

        return str(output_path)

    def convert_all(self, input_dir: Optional[str] = None) -> List[str]:
        """
        Convert all CSV files in a directory to Parquet.

        Args:
            input_dir: Directory containing CSV files (defaults to raw_dir)

        Returns:
            List of paths to created Parquet files
        """
        if input_dir is None:
            input_dir = str(self.raw_dir)

        input_dir = Path(input_dir)
        parquet_files = []

        csv_files = list(input_dir.glob("*.csv"))

        if not csv_files:
            print(f"No CSV files found in {input_dir}")
            return parquet_files

        for csv_file in csv_files:
            output_path = self.parquet_dir / f"{csv_file.stem}.parquet"
            self.convert_file(str(csv_file), str(output_path))
            parquet_files.append(str(output_path))

        print(f"\nConverted {len(parquet_files)} files to Parquet format")
        return parquet_files

    def convert_with_schema(self, input_path: str, schema: dict, output_path: Optional[str] = None) -> str:
        """
        Convert CSV with explicit schema.

        Args:
            input_path: Path to the input CSV file
            schema: Dictionary mapping column names to types
            output_path: Optional output path for Parquet file

        Returns:
            Path to the created Parquet file
        """
        input_path = Path(input_path)

        if output_path is None:
            output_path = self.parquet_dir / f"{input_path.stem}.parquet"
        else:
            output_path = Path(output_path)

        # Read CSV
        df = pd.read_csv(input_path)

        # Apply schema conversions
        for col, dtype in schema.items():
            if col in df.columns:
                if dtype == 'datetime':
                    df[col] = pd.to_datetime(df[col])
                else:
                    df[col] = df[col].astype(dtype)

        # Convert to Arrow and write Parquet
        table = pa.Table.from_pandas(df)
        pq.write_table(table, output_path)

        print(f"Converted {input_path.name} with schema -> {output_path.name}")

        return str(output_path)


def convert_all_data(raw_dir: str = "data/raw", parquet_dir: str = "data/parquet") -> List[str]:
    """
    Convert all downloaded CSV data to Parquet format.

    Args:
        raw_dir: Directory containing raw CSV files
        parquet_dir: Directory to save Parquet files

    Returns:
        List of paths to created Parquet files
    """
    converter = CSVToParquetConverter(raw_dir, parquet_dir)
    return converter.convert_all()


if __name__ == "__main__":
    # Run conversion
    parquet_files = convert_all_data()

    print("\nParquet files created:")
    for f in parquet_files:
        print(f"  {f}")
